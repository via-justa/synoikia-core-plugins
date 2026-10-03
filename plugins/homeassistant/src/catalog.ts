import { compileRules, isPlainObject, parsePluginSettings, staticCatalog, toGroup } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import type { EntityFilter } from './registry.js';

/**
 * The Home Assistant catalog (HA §2.2–§2.3): every `domain.service` from `get_services`, plus the
 * fixed WebSocket/REST commands declared in plugin.yaml for reads and config objects, which
 * `get_services` doesn't list. There is no raw `ws_command` passthrough: anything not in this catalog
 * is unreachable.
 *
 * Classification is stricter than for other plugins: every service is a write, whatever its name
 * (HA's metadata can't tell "turn on a light" from "unlock a door"); plugin.yaml's locks always win.
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

const strList = (description: string) => ({
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description,
});

const strings = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new Error(`plugin.yaml plugin.${name} must be a list of strings`);
  return v;
};

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const ids = isPlainObject(p.registryIds) ? p.registryIds : {};
    return {
      garageClasses: new Set(strings(p.garageClasses, 'garageClasses')),
      protectedDomains: new Set(strings(p.protectedDomains, 'protectedDomains')),
      registryEvents: strings(p.registryEvents, 'registryEvents'),
      catalogEvents: strings(p.catalogEvents, 'catalogEvents'),
      registryTtlMs: typeof p.registryTtlMs === 'number' ? p.registryTtlMs : 300_000,
      registryIds: Object.fromEntries(
        Object.entries(ids).map(([k, v]) => {
          if (typeof v !== 'string') throw new Error(`plugin.yaml plugin.registryIds.${k} must be a string`);
          return [k, v];
        }),
      ) as Record<string, string>,
    };
  },
});

/** plugin.yaml's rules, without upstream lookups (confirmation literals compile their own per instance). */
export const policy = compileRules(settings);

/** Services plugin.yaml locks by name. */
export const LOCKED_SERVICES = new Set(
  settings.rules
    .filter((r) => r.locked)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((m) => isServiceKey(m)),
);

export type SplitSuffix = '#garage' | '#protected';

/** The split twin a service may take, if plugin.yaml declares one. */
export const splitOf = (key: string): SplitSuffix | undefined => {
  const suffix = policy.splits(key)[0];
  return suffix ? (`#${suffix}` as SplitSuffix) : undefined;
};

/** Whether a target makes a split service take its locked twin. */
export function isSensitiveTarget(suffix: SplitSuffix, target: { domain: string; deviceClass?: string }): boolean {
  const garage = target.domain === 'cover' && settings.plugin.garageClasses.has(target.deviceClass ?? '');
  return suffix === '#garage' ? garage : garage || settings.plugin.protectedDomains.has(target.domain);
}

/** The object types whose config lives behind REST (`/api/config/<type>/config/<id>`). */
export const CONFIG_OBJECTS = ['automation', 'script', 'scene'] as const;
export type ConfigObject = (typeof CONFIG_OBJECTS)[number];

export interface FixedCommand {
  group: string;
  classification: 'read' | 'write';
  /** `config` writes go through `prepareWrite` (patch + config_hash, HA §2.8). */
  kind: string;
  summary: string;
  locked?: boolean;
  attestation?: boolean;
  paramsSchema?: Record<string, unknown>;
}

/** The fixed commands plugin.yaml declares, by key. */
export const FIXED_COMMANDS: Record<string, FixedCommand> = Object.fromEntries(
  settings.operations.map((op) => [
    op.key,
    {
      group: op.group,
      classification: op.classification,
      kind: op.kind,
      summary: op.summary,
      ...(policy.isLocked(op.key) ? { locked: true } : {}),
      ...(op.attestation ? { attestation: true } : {}),
      ...(op.paramsSchema ? { paramsSchema: op.paramsSchema } : {}),
    },
  ]),
);

/** Ids a registry command names, for confirmation literals. */
export const REGISTRY_ID_FIELD: Record<string, string> = settings.plugin.registryIds;

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

function serviceDraft(key: string, info: ServiceInfo) {
  const domain = key.split('.')[0]!;
  const fields = flattenFields(info.fields);
  const properties: Record<string, unknown> = Object.fromEntries(fields.map(([name, f]) => [name, fieldSchema(f)]));
  const required = fields.filter(([, f]) => f.required).map(([name]) => name);
  if (info.target) properties.target = TARGET_SCHEMA;
  const summary = [info.name, info.description].filter(Boolean).join(': ').slice(0, 500);
  return {
    key,
    kind: 'service',
    group: toGroup(domain, 'other'),
    classification: 'write' as const,
    classificationReason: 'call_service-default',
    ...(info.target ? { matchProfile: 'targets' } : {}),
    paramsSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    ...(summary ? { docs: { summary } } : {}),
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
      if (policy.excluded(key)) continue;
      known.set(key, info ?? {});
      operations.push(...policy.describe(serviceDraft(key, info ?? {})));
    }
  }
  operations.push(...staticCatalog(policy, { reasonPrefix: 'command-shape' }));
  return { operations: operations.sort((a, b) => a.key.localeCompare(b.key)), services: known };
}

/** Service calls are `domain.service`; fixed commands always contain a `/` or are known names. */
export function isServiceKey(key: string): boolean {
  return /^[a-z0-9_]+\.[a-z0-9_]+(#[a-z-]+)?$/.test(key);
}
