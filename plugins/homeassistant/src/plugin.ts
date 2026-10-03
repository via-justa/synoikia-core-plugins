import {
  compileRules,
  definePlugin,
  ErrorCodes,
  notify,
  PluginError,
  requireString as requireField,
  tryOr,
} from '@synoikia/plugin-sdk';
import type { ConfirmContext, Lazy, PluginHandlers, ResolvedTarget } from '@synoikia/plugin-sdk';
import {
  buildCatalog,
  entityFilter,
  FIXED_COMMANDS,
  isSensitiveTarget,
  isServiceKey,
  REGISTRY_ID_FIELD,
  settings,
  splitOf,
} from './catalog.js';
import type { Catalog, ConfigObject, Services, SplitSuffix } from './catalog.js';
import { HaClient } from './client.js';
import { guideFor } from './guides.js';
import { buildView, normalizeServiceParams, resolveTarget, toRegistryEntries } from './registry.js';
import type { RawRegistry, RegistryView, Target } from './registry.js';
import { applyPatch, configHash, diff, validatePatch } from './transform.js';

/**
 * The Home Assistant plugin's handlers (design §3.3–§3.4, HA design). The sandbox calls
 * `ha.call(operation, params)`: a `domain.service` from `get_services`, or one of the fixed commands
 * in plugin.yaml. Service params are service data plus a `target`; the plugin resolves targets to
 * concrete entities, and acts on exactly the ones the approver saw. Locks, splits and confirmation
 * literals are in plugin.yaml; the decisions that need the registry are here.
 */

const {
  registryEvents: REGISTRY_EVENTS,
  catalogEvents: CATALOG_EVENTS,
  registryTtlMs: REGISTRY_TTL_MS,
} = settings.plugin;
const LOOKUP_TIMEOUT_MS = settings.defaults.timeouts.lookup;
const MAX_SUMMARY_DATA = 300;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const baseKey = (key: string) => key.split('#')[0]!;
const configCommand = (key: string) =>
  /^config\/(automation|script|scene)\/config\/(get|create|update|delete)$/.exec(key);
const registryCommand = (key: string) => /^config\/([a-z]+)_registry\/([a-z]+)$/.exec(key);

function withoutAttestation(params: Record<string, unknown>): Record<string, unknown> {
  const { best_practice_key: _drop, ...rest } = params;
  return rest;
}

function requireString(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== 'string' || !v) throw new PluginError(ErrorCodes.InvalidParams, `${name} is required`);
  if (v.includes('/') || v.includes('..')) throw new PluginError(ErrorCodes.InvalidParams, `${name} is not a valid id`);
  return v;
}

const conflict = (what: string) =>
  new PluginError(
    ErrorCodes.ConfigConflict,
    `${what} changed since it was read (config_hash no longer matches); read it again and resubmit the patch`,
  );

export function createHomeAssistantPlugin(): PluginHandlers {
  let view: { at: number; value: RegistryView } | undefined;
  let catalogCache: Lazy<Catalog> | undefined;

  const onEvent = (eventType: string) => {
    if (REGISTRY_EVENTS.includes(eventType)) view = undefined;
    if (CATALOG_EVENTS.includes(eventType)) {
      catalogCache?.reset();
      notify({ method: 'catalogChanged', params: { reason: eventType } });
    }
  };

  return definePlugin({
    connect: ({ config, secrets }) =>
      new HaClient(
        {
          baseUrl: requireField(config, 'baseUrl'),
          token: requireField(secrets, 'token'),
          verifyTls: config.verifyTls !== false,
        },
        { events: [...REGISTRY_EVENTS, ...CATALOG_EVENTS], onEvent, timeoutMs: settings.defaults.timeouts.request },
      ),
    close: (client) => client.close(),

    async version(kit) {
      const cfg = await kit.client().command('get_config', {}, LOOKUP_TIMEOUT_MS);
      const v = isObject(cfg) && typeof cfg.version === 'string' ? cfg.version : kit.client().version;
      if (!v) throw new PluginError(ErrorCodes.UpstreamError, 'Home Assistant reported no version');
      return v;
    },

    handlers(kit) {
      const connected = kit.client;
      kit.onInit(() => {
        view = undefined;
      });
      const catalog = kit.lazy(async () => buildCatalog((await connected().command('get_services')) as Services));
      catalogCache = catalog;
      const currentCatalog = () => catalog.get();

      const loadView = async (force = false): Promise<RegistryView> => {
        if (!force && view && Date.now() - view.at < REGISTRY_TTL_MS) return view.value;
        const c = connected();
        const [areas, floors, devices, entities, labels, states] = await Promise.all([
          c.command('config/area_registry/list'),
          c.command('config/floor_registry/list'),
          c.command('config/device_registry/list'),
          c.command('config/entity_registry/list'),
          c.command('config/label_registry/list'),
          c.command('get_states'),
        ]);
        const value = buildView({ areas, floors, devices, entities, labels, states } as RawRegistry);
        view = { at: Date.now(), value };
        return value;
      };

      const readConfigObject = async (type: ConfigObject, id: string): Promise<Record<string, unknown>> => {
        const config = await connected().rest('GET', `/config/${type}/config/${encodeURIComponent(id)}`);
        if (!isObject(config))
          throw new PluginError(ErrorCodes.UpstreamError, `Home Assistant returned no ${type} config for ${id}`);
        return config;
      };
      const exists = async (type: ConfigObject, id: string) => {
        try {
          await readConfigObject(type, id);
          return true;
        } catch (err) {
          if (err instanceof PluginError && (err.data as { status?: number } | undefined)?.status === 404) return false;
          throw err;
        }
      };
      const readDashboard = async (urlPath?: string) =>
        connected().command('lovelace/config', urlPath ? { url_path: urlPath } : {});

      const lookup = tryOr;

      const namesOf = (targets: readonly ResolvedTarget[]) => targets.map((t) => t.name || t.id);

      /** Entity ids a scene.apply call sets. */
      const sceneEntities = (params: Record<string, unknown>): string[] => {
        const entities = params.entities;
        if (!isObject(entities))
          throw new PluginError(ErrorCodes.InvalidParams, 'scene.apply needs an entities object');
        return Object.keys(entities);
      };

      /** Ids that make a split service take its locked twin; unknown entities count (fail closed). */
      const sensitiveIds = (v: RegistryView, split: SplitSuffix, ids: string[]) =>
        ids.filter((id) => {
          const e = v.entities.get(id);
          return !e || isSensitiveTarget(split, e);
        });

      /** Whether a split service touches something sensitive (design §3.4 target-conditional keys). */
      const sensitive = async (key: string, split: SplitSuffix, params: Record<string, unknown>) => {
        const v = await loadView();
        if (key === 'scene.apply') return sensitiveIds(v, split, sceneEntities(params)).length > 0;
        if (!params.target) return false;
        const targets = resolveTarget(v, params.target as Target, entityFilter(catalog.peek()?.services.get(key)));
        if (key === 'scene.turn_on') {
          // A scene sets its members' states: look through it. A scene with no member list counts.
          return targets.some((t) => {
            const members = v.entities.get(t.id)?.members;
            return !members || sensitiveIds(v, split, members).length > 0;
          });
        }
        return targets.some((t) => isSensitiveTarget(split, v.entities.get(t.id) ?? { domain: '' }));
      };

      /** Confirmation sources that need the registry or a config read (plugin.yaml `confirm: { custom }`). */
      const rules = compileRules(settings, {
        lookup: (op, args, timeoutMs) => connected().command(op, (args[0] ?? {}) as Record<string, unknown>, timeoutMs),
        custom: {
          'protected-scene-entities': async ({ params }: ConfirmContext) => {
            const v = await loadView();
            return sensitiveIds(v, '#protected', sceneEntities(params as Record<string, unknown>))
              .map((id) => v.entities.get(id)?.name ?? id)
              .join(', ');
          },
          'config-alias': async ({ key, params }: ConfirmContext) => {
            const type = configCommand(key)?.[1] as ConfigObject | undefined;
            const id = String((params as Record<string, unknown>).id ?? '');
            const config = type ? await lookup(() => readConfigObject(type, id)) : undefined;
            return (isObject(config) && typeof config.alias === 'string' && config.alias) || id;
          },
          'registry-name': async ({ key, params }: ConfirmContext) => {
            const reg = registryCommand(key);
            if (!reg) return undefined;
            const id = String((params as Record<string, unknown>)[REGISTRY_ID_FIELD[reg[1]!] ?? ''] ?? '');
            const v = await lookup(() => loadView());
            const names: Record<string, { get(id: string): { name?: string } | undefined } | undefined> = {
              area: v?.areas,
              entity: v?.entities,
              floor: v?.floors,
              label: v?.labels,
            };
            return names[reg[1]!]?.get(id)?.name || id;
          },
        },
      });

      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },

        async syncRegistry() {
          return toRegistryEntries(await loadView(true));
        },

        async resolveOperation({ fn, args }) {
          if (fn !== 'call') throw new PluginError(ErrorCodes.UnknownOperation, `ha.${fn} is not a binding function`);
          const [key, raw] = args;
          if (typeof key !== 'string' || !key || key.includes('#'))
            throw new PluginError(
              ErrorCodes.InvalidParams,
              'ha.call(operation, params): operation must be a name like light.turn_on',
            );
          if (isServiceKey(key)) {
            if (!(await currentCatalog()).services.has(key))
              throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a service on this Home Assistant`);
            const params = normalizeServiceParams(raw);
            const split = splitOf(key);
            if (split && (await sensitive(key, split, params))) return { key: `${key}${split}`, params };
            return { key, params };
          }
          if (!FIXED_COMMANDS[key])
            throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a Home Assistant operation`);
          if (raw !== undefined && !isObject(raw))
            throw new PluginError(ErrorCodes.InvalidParams, 'params must be an object');
          return { key, params: raw ?? {} };
        },

        async resolveTargets({ key, params }) {
          if (!isServiceKey(key) || !isObject(params) || !params.target) return [];
          const info = (await currentCatalog()).services.get(baseKey(key));
          return resolveTarget(await loadView(), params.target as Target, entityFilter(info));
        },

        async prepareWrite({ key, params }) {
          if (!isObject(params)) throw new PluginError(ErrorCodes.InvalidParams, 'params must be an object');
          const patch = validatePatch(params.patch);
          if (typeof params.config_hash !== 'string' || !params.config_hash)
            throw new PluginError(ErrorCodes.InvalidParams, 'config_hash is required (from the matching …/get read)');
          const cfg = configCommand(key);
          if (cfg?.[2] === 'update') {
            const type = cfg[1] as ConfigObject;
            const id = requireString(params, 'id');
            const live = await readConfigObject(type, id);
            const liveHash = configHash(live);
            if (liveHash !== params.config_hash) throw conflict(`The ${type} ${id}`);
            const next = applyPatch(live, patch);
            return { params: { id, config: next }, diff: diff(live, next), expectedHash: liveHash };
          }
          if (key === 'lovelace/config/save') {
            const urlPath = typeof params.url_path === 'string' && params.url_path ? params.url_path : undefined;
            const live = await readDashboard(urlPath);
            const liveHash = configHash(live);
            if (liveHash !== params.config_hash) throw conflict(`The dashboard ${urlPath ?? '(default)'}`);
            const next = applyPatch(live, patch);
            return {
              params: { ...(urlPath ? { url_path: urlPath } : {}), config: next },
              diff: diff(live, next),
              expectedHash: liveHash,
            };
          }
          throw new PluginError(ErrorCodes.UnknownOperation, `${key} has no config transform`);
        },

        async summarize({ key, params, targets }) {
          const p = isObject(params) ? params : {};
          const base = baseKey(key);
          let text: string;
          if (isServiceKey(base)) {
            const info = (await lookup(currentCatalog))?.services.get(base);
            const { target: _t, best_practice_key: _k, ...data } = p;
            const json = Object.keys(data).length ? JSON.stringify(data) : '';
            const shown = json.length > MAX_SUMMARY_DATA ? `${json.slice(0, MAX_SUMMARY_DATA)}…` : json;
            text = `${info?.name ?? base} (${base})${targets.length ? ` on ${namesOf(targets).join(', ')}` : ''}${shown ? ` with ${shown}` : ''}`;
            if (key.endsWith('#garage')) text += ' (a garage door or gate)';
            if (key.endsWith('#protected')) text += ' (a lock, alarm panel, garage door or gate)';
          } else {
            const { best_practice_key: _k, config: _c, patch, ...rest } = p;
            const json = JSON.stringify(rest);
            text = `Home Assistant ${key}${json !== '{}' ? ` ${json.length > MAX_SUMMARY_DATA ? `${json.slice(0, MAX_SUMMARY_DATA)}…` : json}` : ''}${
              Array.isArray(patch) ? ` (${patch.length} patch operation${patch.length === 1 ? '' : 's'})` : ''
            }`;
          }
          const literal = await rules.confirmLiteral({ key, params: p, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async getGuide({ key }) {
          const guide = guideFor(key);
          if (!guide) throw new PluginError(ErrorCodes.UnknownOperation, `${key} has no best-practice guide`);
          return guide;
        },

        async invoke({ key, params, context }) {
          const p = withoutAttestation(isObject(params) ? params : {});
          const timeout = kit.timeout(context);
          const c = connected();
          const base = baseKey(key);

          if (isServiceKey(base)) {
            const [domain, service] = base.split('.') as [string, string];
            const info = (await currentCatalog()).services.get(base);
            if (!info)
              throw new PluginError(ErrorCodes.UnknownOperation, `${base} is not a service on this Home Assistant`);
            const { target, ...data } = p;
            // Act on exactly the entities the approver saw (or the rule matched), not the area/device spec.
            const approved = context.targets ?? [];
            if (target && approved.length === 0)
              throw new PluginError(ErrorCodes.TargetResolutionFailed, `The target of ${base} matches no entities`);
            const result = await c.command(
              'call_service',
              {
                domain,
                service,
                service_data: data,
                ...(target ? { target: { entity_id: approved.map((t) => t.id) } } : {}),
                ...(info.response ? { return_response: true } : {}),
              },
              timeout,
            );
            return isObject(result) && 'response' in result ? result.response : result;
          }

          const cfg = configCommand(key);
          if (cfg) {
            const type = cfg[1] as ConfigObject;
            const verb = cfg[2];
            if (verb === 'create') {
              if (!isObject(p.config)) throw new PluginError(ErrorCodes.InvalidParams, 'config must be an object');
              const id =
                p.id === undefined ? `${type === 'script' ? 'script_' : ''}${Date.now()}` : requireString(p, 'id');
              // Create never overwrites: an existing object is edited with update (patch + config_hash + diff).
              if (await exists(type, id))
                throw new PluginError(
                  ErrorCodes.InvalidParams,
                  `The ${type} ${id} already exists; use config/${type}/config/update`,
                );
              const body = type === 'automation' ? { ...p.config, id } : p.config;
              await c.rest('POST', `/config/${type}/config/${encodeURIComponent(id)}`, body, timeout);
              return { id };
            }
            const id = requireString(p, 'id');
            if (verb === 'get') {
              const config = await readConfigObject(type, id);
              return { id, config, config_hash: configHash(config) };
            }
            if (verb === 'update') {
              const live = await readConfigObject(type, id);
              if (configHash(live) !== context.expectedHash) throw conflict(`The ${type} ${id}`);
              await c.rest('POST', `/config/${type}/config/${encodeURIComponent(id)}`, p.config, timeout);
              return { id, config_hash: configHash(p.config) };
            }
            await c.rest('DELETE', `/config/${type}/config/${encodeURIComponent(id)}`, undefined, timeout);
            return { id, deleted: true };
          }

          if (key === 'lovelace/config') {
            const config = await readDashboard(typeof p.url_path === 'string' ? p.url_path : undefined);
            return { config, config_hash: configHash(config) };
          }
          if (key === 'lovelace/config/save') {
            const urlPath = typeof p.url_path === 'string' ? p.url_path : undefined;
            if (configHash(await readDashboard(urlPath)) !== context.expectedHash)
              throw conflict(`The dashboard ${urlPath ?? '(default)'}`);
            await c.command(
              'lovelace/config/save',
              { ...(urlPath ? { url_path: urlPath } : {}), config: p.config },
              timeout,
            );
            return { config_hash: configHash(p.config) };
          }
          if (key === 'get_states') {
            const states = (await c.command('get_states', {}, timeout)) as { entity_id: string }[];
            const list = (v: unknown) =>
              v === undefined ? undefined : new Set(Array.isArray(v) ? v.map(String) : [String(v)]);
            const ids = list(p.entity_id);
            const domains = list(p.domain);
            const areas = list(p.area);
            const v = areas ? await loadView() : undefined;
            return states.filter(
              (s) =>
                (!ids || ids.has(s.entity_id)) &&
                (!domains || domains.has(s.entity_id.split('.')[0]!)) &&
                (!areas || areas.has(v!.entities.get(s.entity_id)?.area ?? '')),
            );
          }
          if (!FIXED_COMMANDS[key])
            throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a Home Assistant operation`);
          const result = await c.command(key, p, timeout);
          if (registryCommand(key) && !key.endsWith('/list')) view = undefined;
          return result;
        },
      };
    },
  });
}
