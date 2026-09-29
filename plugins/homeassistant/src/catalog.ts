import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import type { EntityFilter } from './registry.js';

/**
 * The Home Assistant catalog (HA §2.2–§2.3): every `domain.service` from `get_services`, plus a fixed
 * seed list of WebSocket/REST commands for reads and config objects, which `get_services` doesn't
 * list. There is no raw `ws_command` passthrough: anything not in this catalog is unreachable.
 *
 * Classification is stricter than TrueNAS/Seerr: every service is a write, whatever its name
 * (HA's metadata can't tell "turn on a light" from "unlock a door"); a locked list always wins.
 */

export interface ServiceField {
  name?: string;
  description?: string;
  required?: boolean;
  example?: unknown;
  selector?: Record<string, unknown>;
  /** Collapsible sections nest their fields. */
  fields?: Record<string, ServiceField>;
}

export interface ServiceInfo {
  name?: string;
  description?: string;
  fields?: Record<string, ServiceField>;
  target?: unknown;
  response?: { optional?: boolean };
}

export type Services = Record<string, Record<string, ServiceInfo>>;

/** Physical-safety or system-integrity critical: always a human with a typed confirmation (HA §3.4). */
export const LOCKED_SERVICES = new Set([
  'lock.unlock',
  'lock.open',
  'alarm_control_panel.alarm_disarm',
  'homeassistant.restart',
  'homeassistant.stop',
  'hassio.host_reboot',
  'hassio.host_shutdown',
  'hassio.restore_full',
  'hassio.restore_partial',
  'backup.restore',
]);

/**
 * Services whose risk depends on what they target (design §3.4): `resolveOperation` picks the locked
 * twin when any resolved target is sensitive. Judged by device class and domain, never by name: a
 * false negative is a physical-security miss.
 * - `#garage`: opening a cover that is a garage door or gate.
 * - `#protected`: the generic homeassistant.turn_on/turn_off/toggle on a lock, an alarm panel or a
 *   garage door or gate (turn_on opens a cover, turn_off unlocks a lock); scene.apply setting one of
 *   those, and scene.turn_on on a scene that includes one (an unknown entity counts as protected).
 */
export const SPLITS: Record<string, '#garage' | '#protected'> = {
  'cover.open_cover': '#garage',
  'cover.toggle': '#garage',
  'cover.set_cover_position': '#garage',
  'homeassistant.turn_on': '#protected',
  'homeassistant.turn_off': '#protected',
  'homeassistant.toggle': '#protected',
  // Scenes set entity states directly (a lock to unlocked, a garage door to open).
  'scene.apply': '#protected',
  'scene.turn_on': '#protected',
};
const SPLIT_DESCRIPTIONS = {
  '#garage': 'on a garage door or gate: locked.',
  '#protected': 'on a lock, an alarm panel, or a garage door or gate: locked.',
};
export const GARAGE_CLASSES = new Set(['garage', 'gate']);
const PROTECTED_DOMAINS = new Set(['lock', 'alarm_control_panel']);

/** Whether a target makes a split service take its locked twin. */
export function isSensitiveTarget(
  suffix: '#garage' | '#protected',
  target: { domain: string; deviceClass?: string },
): boolean {
  const garage = target.domain === 'cover' && GARAGE_CLASSES.has(target.deviceClass ?? '');
  return suffix === '#garage' ? garage : garage || PROTECTED_DOMAINS.has(target.domain);
}

type CommandKind = 'ws_command' | 'config';

export interface FixedCommand {
  group: string;
  classification: 'read' | 'write';
  /** `config` writes go through `prepareWrite` (patch + config_hash, HA §2.8). */
  kind: CommandKind;
  summary: string;
  locked?: boolean;
  attestation?: boolean;
  paramsSchema?: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const str = (description: string) => ({ type: 'string', description });
const strList = (description: string) => ({
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description,
});
const PATCH = {
  type: 'array',
  description:
    'RFC 6902 JSON Patch against the object read with …/get: ops add, remove, replace, test; "-" appends to an array.',
  items: obj(
    { op: { enum: ['add', 'remove', 'replace', 'test'] }, path: str('JSON pointer, e.g. /triggers/-'), value: {} },
    ['op', 'path'],
  ),
};

/** The object types whose config lives behind REST (`/api/config/<type>/config/<id>`). */
export const CONFIG_OBJECTS = ['automation', 'script', 'scene'] as const;
export type ConfigObject = (typeof CONFIG_OBJECTS)[number];

/** Registries managed over WebSocket (`config/<name>_registry/<verb>`). */
const REGISTRIES = {
  area: { verbs: ['create', 'update', 'delete'], id: 'area_id' },
  floor: { verbs: ['create', 'update', 'delete'], id: 'floor_id' },
  label: { verbs: ['create', 'update', 'delete'], id: 'label_id' },
  category: { verbs: ['create', 'update', 'delete'], id: 'category_id' },
  device: { verbs: ['update'], id: 'device_id' },
  entity: { verbs: ['update', 'remove'], id: 'entity_id' },
} as const;

function fixedCommands(): Record<string, FixedCommand> {
  const c: Record<string, FixedCommand> = {
    get_states: {
      group: 'states',
      classification: 'read',
      kind: 'ws_command',
      summary: 'Current states. Filter with entity_id, domain or area rather than reading everything.',
      paramsSchema: obj({
        entity_id: strList('Entity id(s)'),
        domain: strList('Domain(s), e.g. light'),
        area: strList('Area id(s)'),
      }),
    },
    get_config: {
      group: 'system',
      classification: 'read',
      kind: 'ws_command',
      summary: 'Core configuration: version, location, units.',
    },
    'history/history_during_period': {
      group: 'history',
      classification: 'read',
      kind: 'ws_command',
      summary: 'State history of some entities over a period.',
      paramsSchema: obj(
        {
          start_time: str('ISO 8601'),
          end_time: str('ISO 8601'),
          entity_ids: { type: 'array', items: { type: 'string' } },
          minimal_response: { type: 'boolean' },
          no_attributes: { type: 'boolean' },
          significant_changes_only: { type: 'boolean' },
        },
        ['start_time', 'entity_ids'],
      ),
    },
    'logbook/get_events': {
      group: 'logbook',
      classification: 'read',
      kind: 'ws_command',
      summary: 'Logbook events over a period.',
      paramsSchema: obj(
        {
          start_time: str('ISO 8601'),
          end_time: str('ISO 8601'),
          entity_ids: { type: 'array', items: { type: 'string' } },
        },
        ['start_time'],
      ),
    },
    'lovelace/dashboards/list': {
      group: 'dashboard',
      classification: 'read',
      kind: 'ws_command',
      summary: 'Dashboards.',
    },
    'lovelace/config': {
      group: 'dashboard',
      classification: 'read',
      kind: 'ws_command',
      summary: 'A dashboard config and its config_hash (for lovelace/config/save).',
      paramsSchema: obj({ url_path: str('Dashboard url_path; omit for the default dashboard') }),
    },
    'lovelace/config/save': {
      group: 'dashboard',
      classification: 'write',
      kind: 'config',
      summary: 'Edit a dashboard with a JSON Patch against the config_hash read by lovelace/config.',
      paramsSchema: obj(
        { url_path: str('Dashboard url_path'), config_hash: str('From lovelace/config'), patch: PATCH },
        ['config_hash', 'patch'],
      ),
    },
  };
  for (const type of CONFIG_OBJECTS) {
    const idHelp = type === 'script' ? 'Script object id (script.<id>)' : `${type} config id (the "id" field)`;
    c[`config/${type}/config/get`] = {
      group: type,
      classification: 'read',
      kind: 'ws_command',
      summary: `A ${type}'s config and its config_hash (for config/${type}/config/update).`,
      paramsSchema: obj({ id: str(idHelp) }, ['id']),
    };
    c[`config/${type}/config/create`] = {
      group: type,
      classification: 'write',
      kind: 'ws_command',
      attestation: true,
      summary: `Create a ${type} from a full config. Read its guide with guides.get first.`,
      paramsSchema: obj({ id: str(`${idHelp}; generated when omitted`), config: { type: 'object' } }, ['config']),
    };
    c[`config/${type}/config/update`] = {
      group: type,
      classification: 'write',
      kind: 'config',
      attestation: true,
      summary: `Edit a ${type} with a JSON Patch against the config_hash read by config/${type}/config/get.`,
      paramsSchema: obj({ id: str(idHelp), config_hash: str('From …/get'), patch: PATCH }, [
        'id',
        'config_hash',
        'patch',
      ]),
    };
    c[`config/${type}/config/delete`] = {
      group: type,
      classification: 'write',
      kind: 'ws_command',
      locked: true,
      summary: `Delete a ${type}.`,
      paramsSchema: obj({ id: str(idHelp) }, ['id']),
    };
  }
  for (const [name, reg] of Object.entries(REGISTRIES)) {
    c[`config/${name}_registry/list`] = {
      group: name,
      classification: 'read',
      kind: 'ws_command',
      summary: `The ${name} registry.`,
      ...(name === 'category' ? { paramsSchema: obj({ scope: str('e.g. automation') }, ['scope']) } : {}),
    };
    for (const verb of reg.verbs) {
      c[`config/${name}_registry/${verb}`] = {
        group: name,
        classification: 'write',
        kind: 'ws_command',
        locked: verb === 'delete' || verb === 'remove',
        summary: `${verb[0]!.toUpperCase()}${verb.slice(1)} a${name === 'area' || name === 'entity' ? 'n' : ''} ${name} registry entry.`,
        paramsSchema: obj(
          { ...(verb === 'create' ? {} : { [reg.id]: str(`The ${name} id`) }) },
          verb === 'create' ? [] : [reg.id],
        ),
      };
    }
  }
  return c;
}

export const FIXED_COMMANDS = fixedCommands();

/** Ids a registry command names, for confirmation literals. */
export const REGISTRY_ID_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(REGISTRIES).map(([name, reg]) => [name, reg.id]),
);

const asList = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The entities a service acts on, from its target selector (`target.entity`: one filter or a list of
 * alternatives, each with an optional `domain` and `integration`). No filter, or any alternative
 * without one, means every entity.
 */
export function entityFilter(info: ServiceInfo | undefined): EntityFilter {
  const target = info?.target;
  if (!target || typeof target !== 'object') return [];
  const raw = (target as { entity?: unknown }).entity;
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const filter = entries.map((e) => {
    const f = (e ?? {}) as { domain?: unknown; integration?: unknown };
    return {
      ...(asList(f.domain).length ? { domain: asList(f.domain) } : {}),
      ...(typeof f.integration === 'string' && f.integration ? { integration: f.integration } : {}),
    };
  });
  return filter.some((f) => !f.domain && !f.integration) ? [] : filter;
}

const MATCH_PROFILES: Record<string, string> = { 'climate.set_temperature': 'climate.set_temperature' };

const sanitizeGroup = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/^[^a-z0-9]+/, '') || 'other';

/** A service field's selector, as a JSON schema (best effort; HA validates the call itself). */
function fieldSchema(field: ServiceField): Record<string, unknown> {
  const sel = field.selector ?? {};
  const [kind, cfg] = Object.entries(sel)[0] ?? [];
  const conf = (cfg ?? {}) as Record<string, unknown>;
  let schema: Record<string, unknown> = {};
  if (kind === 'number') {
    schema = {
      type: 'number',
      ...(typeof conf.min === 'number' ? { minimum: conf.min } : {}),
      ...(typeof conf.max === 'number' ? { maximum: conf.max } : {}),
    };
  } else if (kind === 'boolean') schema = { type: 'boolean' };
  else if (kind === 'text' || kind === 'time' || kind === 'date' || kind === 'datetime') schema = { type: 'string' };
  else if (kind === 'select' && Array.isArray(conf.options)) {
    const values = conf.options.map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : o));
    schema = conf.multiple ? { type: 'array', items: { enum: values } } : { enum: values };
  } else if (kind === 'entity') schema = strList('Entity id(s)');
  const text = [field.name, field.description].filter(Boolean).join(': ');
  return {
    ...schema,
    ...(text ? { description: text } : {}),
    ...(field.example !== undefined ? { examples: [field.example] } : {}),
  };
}

function flattenFields(fields: Record<string, ServiceField> = {}): [string, ServiceField][] {
  return Object.entries(fields).flatMap(([name, f]) =>
    f.fields ? flattenFields(f.fields) : [[name, f] as [string, ServiceField]],
  );
}

const TARGET_SCHEMA = {
  type: 'object',
  description:
    'What to act on. entity_id, area_id, device_id, floor_id and label_id may also be given at the top level.',
  properties: {
    entity_id: strList('Entity id(s)'),
    area_id: strList('Area id(s)'),
    device_id: strList('Device id(s)'),
    floor_id: strList('Floor id(s)'),
    label_id: strList('Label id(s)'),
  },
};

function describeService(key: string, info: ServiceInfo): OperationDescriptor {
  const domain = key.split('.')[0]!;
  const suffix = key.includes('#') ? (key.slice(key.indexOf('#')) as keyof typeof SPLIT_DESCRIPTIONS) : undefined;
  const locked = LOCKED_SERVICES.has(key) || !!suffix;
  const fields = flattenFields(info.fields);
  const properties: Record<string, unknown> = Object.fromEntries(fields.map(([name, f]) => [name, fieldSchema(f)]));
  const required = fields.filter(([, f]) => f.required).map(([name]) => name);
  if (info.target) properties.target = TARGET_SCHEMA;
  const base = key.split('#')[0]!;
  const summary = [info.name, info.description].filter(Boolean).join(': ').slice(0, 500);
  return {
    key,
    kind: 'service',
    group: sanitizeGroup(domain),
    classification: 'write',
    classificationReason: locked ? 'locked:physical-or-system' : 'call_service-default',
    locked,
    typedConfirmation: locked,
    ...(MATCH_PROFILES[base] ? { matchProfile: MATCH_PROFILES[base] } : info.target ? { matchProfile: 'targets' } : {}),
    paramsSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    ...(summary || suffix
      ? {
          docs: {
            ...(summary ? { summary } : {}),
            ...(suffix ? { description: `${base} ${SPLIT_DESCRIPTIONS[suffix]}` } : {}),
          },
        }
      : {}),
  };
}

function describeCommand(key: string, cmd: FixedCommand): OperationDescriptor {
  return {
    key,
    kind: cmd.kind,
    group: cmd.group,
    classification: cmd.locked ? 'write' : cmd.classification,
    classificationReason: cmd.locked ? 'locked:config-delete' : `command-shape:${cmd.classification}`,
    locked: cmd.locked ?? false,
    typedConfirmation: cmd.locked ?? false,
    attestationRequired: cmd.attestation ?? false,
    ...(cmd.paramsSchema ? { paramsSchema: cmd.paramsSchema } : {}),
    docs: { summary: cmd.summary },
  };
}

export interface Catalog {
  operations: OperationDescriptor[];
  /** `domain.service` → its metadata (whether it takes a target, returns a response). */
  services: Map<string, ServiceInfo>;
}

export function buildCatalog(services: Services): Catalog {
  const operations: OperationDescriptor[] = [];
  const known = new Map<string, ServiceInfo>();
  for (const [domain, byService] of Object.entries(services ?? {})) {
    if (!/^[a-z0-9_]+$/.test(domain) || !byService || typeof byService !== 'object') continue;
    for (const [service, info] of Object.entries(byService)) {
      if (!/^[a-z0-9_]+$/.test(service)) continue;
      const key = `${domain}.${service}`;
      known.set(key, info ?? {});
      operations.push(describeService(key, info ?? {}));
      if (SPLITS[key]) operations.push(describeService(`${key}${SPLITS[key]}`, info ?? {}));
    }
  }
  for (const [key, cmd] of Object.entries(FIXED_COMMANDS)) operations.push(describeCommand(key, cmd));
  return { operations: operations.sort((a, b) => a.key.localeCompare(b.key)), services: known };
}

/** Service calls are `domain.service`; fixed commands always contain a `/` or are known names. */
export const isServiceKey = (key: string) => /^[a-z0-9_]+\.[a-z0-9_]+(#[a-z-]+)?$/.test(key);
