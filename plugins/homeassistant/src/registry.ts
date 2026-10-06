import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import type { RegistryEntry, ResolvedTarget } from '@synoikia/plugin-sdk';

/** The registry view (HA §2.4): areas, floors, devices, labels and entities joined so a target expands
 * to concrete entities; pure, and failing closed on unknown ids. */

export interface RawRegistry {
  areas: { area_id: string; name?: string; floor_id?: string | null; labels?: string[] }[];
  floors: { floor_id: string; name?: string }[];
  devices: {
    id: string;
    name?: string | null;
    name_by_user?: string | null;
    area_id?: string | null;
    labels?: string[];
  }[];
  entities: {
    entity_id: string;
    platform?: string | null;
    device_id?: string | null;
    area_id?: string | null;
    name?: string | null;
    original_name?: string | null;
    labels?: string[];
    device_class?: string | null;
    original_device_class?: string | null;
  }[];
  labels: { label_id: string; name?: string }[];
  states: { entity_id: string; attributes?: Record<string, unknown> }[];
}

export interface EntityView {
  id: string;
  name: string;
  domain: string;
  /** The integration that provides it (entity registry `platform`). */
  platform?: string;
  area?: string;
  device?: string;
  deviceClass?: string;
  labels: string[];
  /** Scenes: the entities the scene sets (its state's `entity_id` attribute). */
  members?: string[];
}

export interface RegistryView {
  entities: Map<string, EntityView>;
  areas: Map<string, { id: string; name: string; floor?: string; labels: string[] }>;
  floors: Map<string, { id: string; name: string }>;
  devices: Map<string, { id: string; name: string; area?: string; labels: string[] }>;
  labels: Map<string, { id: string; name: string }>;
}

const orUndef = (v: string | null | undefined) => (v ? v : undefined);

export function buildView(raw: RawRegistry): RegistryView {
  const areas = new Map(
    (raw.areas ?? []).map((a) => [
      a.area_id,
      { id: a.area_id, name: a.name || a.area_id, floor: orUndef(a.floor_id), labels: a.labels ?? [] },
    ]),
  );
  const floors = new Map((raw.floors ?? []).map((f) => [f.floor_id, { id: f.floor_id, name: f.name || f.floor_id }]));
  const devices = new Map(
    (raw.devices ?? []).map((d) => [
      d.id,
      { id: d.id, name: d.name_by_user || d.name || d.id, area: orUndef(d.area_id), labels: d.labels ?? [] },
    ]),
  );
  const labels = new Map((raw.labels ?? []).map((l) => [l.label_id, { id: l.label_id, name: l.name || l.label_id }]));
  const states = new Map((raw.states ?? []).map((s) => [s.entity_id, s.attributes ?? {}]));
  const entities = new Map<string, EntityView>();
  const add = (id: string, reg?: RawRegistry['entities'][number]) => {
    const attrs = states.get(id) ?? {};
    const device = orUndef(reg?.device_id);
    const friendly = typeof attrs.friendly_name === 'string' ? attrs.friendly_name : undefined;
    const attrClass = typeof attrs.device_class === 'string' ? attrs.device_class : undefined;
    entities.set(id, {
      id,
      name: friendly || reg?.name || reg?.original_name || id,
      domain: id.split('.')[0]!,
      platform: orUndef(reg?.platform),
      // An entity's own area wins; otherwise it inherits its device's.
      area: orUndef(reg?.area_id) ?? (device ? devices.get(device)?.area : undefined),
      device,
      deviceClass: orUndef(reg?.device_class) ?? attrClass ?? orUndef(reg?.original_device_class),
      labels: reg?.labels ?? [],
      ...(Array.isArray(attrs.entity_id) && id.startsWith('scene.')
        ? { members: attrs.entity_id.filter((m): m is string => typeof m === 'string') }
        : {}),
    });
  };
  const registered = new Map((raw.entities ?? []).map((e) => [e.entity_id, e]));
  for (const [id, reg] of registered) add(id, reg);
  // Entities without a registry entry (no unique_id) still have a state.
  for (const id of states.keys()) if (!registered.has(id)) add(id);
  return { entities, areas, floors, devices, labels };
}

/** Mirror entries for core (`registry.find`, the rule pickers). */
export function toRegistryEntries(view: RegistryView): RegistryEntry[] {
  return [
    ...[...view.floors.values()].map((f) => ({ kind: 'floor', id: f.id, name: f.name })),
    ...[...view.areas.values()].map((a) => ({
      kind: 'area',
      id: a.id,
      name: a.name,
      ...(a.floor ? { parentId: a.floor } : {}),
    })),
    ...[...view.devices.values()].map((d) => ({
      kind: 'device',
      id: d.id,
      name: d.name,
      ...(d.area ? { parentId: d.area } : {}),
    })),
    ...[...view.entities.values()].map((e) => ({
      kind: 'entity',
      id: e.id,
      name: e.name,
      ...(e.area ? { parentId: e.area } : {}),
      scopes: { domain: e.domain, ...(e.area ? { area: e.area } : {}) },
      attrs: {
        ...(e.device ? { device_id: e.device } : {}),
        ...(e.deviceClass ? { device_class: e.deviceClass } : {}),
      },
    })),
  ];
}

export const TARGET_KEYS = ['entity_id', 'area_id', 'device_id', 'floor_id', 'label_id'] as const;
export type Target = Partial<Record<(typeof TARGET_KEYS)[number], string[]>>;

const asList = (v: unknown): string[] | undefined => {
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
};

/** Service params as the gate sees them: service data plus one `target`, top-level target keys moved in. */
export function normalizeServiceParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params))
    throw new PluginError(ErrorCodes.InvalidParams, 'ha.call(service, params): params must be an object');
  const { target: rawTarget, ...rest } = params as Record<string, unknown>;
  if (rawTarget !== undefined && (typeof rawTarget !== 'object' || rawTarget === null || Array.isArray(rawTarget)))
    throw new PluginError(ErrorCodes.InvalidParams, 'target must be an object');
  const target: Target = {};
  const take = (source: Record<string, unknown>, key: (typeof TARGET_KEYS)[number]) => {
    if (source[key] === undefined) return;
    const list = asList(source[key]);
    if (!list) throw new PluginError(ErrorCodes.InvalidParams, `${key} must be a string or a list of strings`);
    target[key] = [...new Set([...(target[key] ?? []), ...list])];
  };
  for (const key of TARGET_KEYS) {
    take((rawTarget ?? {}) as Record<string, unknown>, key);
    take(rest, key);
    delete rest[key];
  }
  const unknown = Object.keys((rawTarget ?? {}) as object).filter(
    (k) => !(TARGET_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length) throw new PluginError(ErrorCodes.InvalidParams, `Unknown target key(s): ${unknown.join(', ')}`);
  return Object.keys(target).length ? { ...rest, target } : rest;
}

const unresolved = (what: string, ids: string[]) =>
  new PluginError(ErrorCodes.TargetResolutionFailed, `Unknown ${what}: ${ids.join(', ')}`);

/** The entities a service acts on, from its target selector; an empty list means any entity. */
export type EntityFilter = { domain?: string[]; integration?: string }[];

const passes = (e: EntityView, filter: EntityFilter) =>
  filter.length === 0 ||
  filter.some(
    (f) => (!f.domain?.length || f.domain.includes(e.domain)) && (!f.integration || f.integration === e.platform),
  );

/** Expands a `target` to the concrete entities it covers (HA §3.1), limited to those the service acts on;
 * entities named directly are kept as given. */
export function resolveTarget(view: RegistryView, target: Target | undefined, filter: EntityFilter): ResolvedTarget[] {
  if (!target) return [];
  const ids = new Set<string>();
  const check = (what: string, list: string[] | undefined, has: (id: string) => boolean) => {
    const missing = (list ?? []).filter((id) => !has(id));
    if (missing.length) throw unresolved(what, missing);
    return list ?? [];
  };
  const entityList = target.entity_id ?? [];
  if (entityList.includes('all')) {
    for (const e of view.entities.values()) if (passes(e, filter)) ids.add(e.id);
  }
  for (const id of check(
    'entity',
    entityList.filter((e) => e !== 'all'),
    (id) => view.entities.has(id),
  ))
    ids.add(id);
  const areas = new Set(check('area', target.area_id, (id) => view.areas.has(id)));
  for (const floor of check('floor', target.floor_id, (id) => view.floors.has(id))) {
    for (const a of view.areas.values()) if (a.floor === floor) areas.add(a.id);
  }
  const devices = new Set(check('device', target.device_id, (id) => view.devices.has(id)));
  const labels = new Set(check('label', target.label_id, (id) => view.labels.has(id)));
  if (labels.size) {
    for (const a of view.areas.values()) if (a.labels.some((l) => labels.has(l))) areas.add(a.id);
    for (const d of view.devices.values()) if (d.labels.some((l) => labels.has(l))) devices.add(d.id);
  }
  for (const e of view.entities.values()) {
    if (!passes(e, filter)) continue;
    if ((e.area && areas.has(e.area)) || (e.device && devices.has(e.device)) || e.labels.some((l) => labels.has(l)))
      ids.add(e.id);
  }
  return [...ids].sort().map((id) => {
    const e = view.entities.get(id)!;
    return { kind: 'entity', id, name: e.name, scopes: { domain: e.domain, ...(e.area ? { area: e.area } : {}) } };
  });
}
