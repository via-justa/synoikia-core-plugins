import { ErrorCodes, RegistryEntrySchema } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { buildView, normalizeServiceParams, resolveTarget, toRegistryEntries } from '../src/registry.js';
import type { EntityFilter } from '../src/registry.js';
import type { RawRegistry } from '../src/registry.js';

const raw: RawRegistry = {
  areas: [
    { area_id: 'living_room', name: 'Living Room', floor_id: 'ground' },
    { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
    { area_id: 'garage', name: 'Garage', floor_id: 'ground', labels: ['outdoor'] },
    { area_id: 'attic', name: 'Attic', floor_id: 'top' },
  ],
  floors: [
    { floor_id: 'ground', name: 'Ground floor' },
    { floor_id: 'top', name: 'Top floor' },
  ],
  devices: [
    { id: 'dev_lamp', name: 'Lamp plug', name_by_user: 'Reading lamp', area_id: 'living_room' },
    { id: 'dev_garage', name: 'Garage Door Opener', area_id: 'garage' },
  ],
  labels: [{ label_id: 'outdoor', name: 'Outdoor' }],
  entities: [
    { entity_id: 'light.reading_lamp', device_id: 'dev_lamp' },
    { entity_id: 'light.ceiling', area_id: 'living_room' },
    { entity_id: 'light.kitchen', area_id: 'kitchen' },
    // The entity's own area wins over its device's.
    { entity_id: 'light.moved', device_id: 'dev_lamp', area_id: 'kitchen' },
    { entity_id: 'cover.garage_door', device_id: 'dev_garage', original_device_class: 'garage' },
    { entity_id: 'switch.porch', labels: ['outdoor'] },
  ],
  states: [
    { entity_id: 'light.reading_lamp', attributes: { friendly_name: 'Reading Lamp' } },
    { entity_id: 'light.ceiling', attributes: { friendly_name: 'Living Room Ceiling' } },
    { entity_id: 'sensor.untracked', attributes: { friendly_name: 'Untracked Sensor' } },
  ],
};
const view = buildView(raw);
const only = (...domain: string[]): EntityFilter => [{ domain }];
const ANY: EntityFilter = [];
const ids = (target: Parameters<typeof resolveTarget>[1], filter: EntityFilter = only('light')) =>
  resolveTarget(view, target, filter).map((t) => t.id);

describe('the registry view (HA §2.4)', () => {
  it('joins areas through devices, names entities, and keeps state-only entities', () => {
    expect(view.entities.get('light.reading_lamp')).toMatchObject({
      name: 'Reading Lamp',
      area: 'living_room',
      device: 'dev_lamp',
    });
    expect(view.entities.get('light.moved')).toMatchObject({ area: 'kitchen' });
    expect(view.entities.get('cover.garage_door')).toMatchObject({ area: 'garage', deviceClass: 'garage' });
    expect(view.entities.get('sensor.untracked')).toMatchObject({ name: 'Untracked Sensor', domain: 'sensor' });
    expect(view.entities.get('light.kitchen')?.name).toBe('light.kitchen'); // no friendly name: the id
  });

  it('mirrors floors, areas, devices and entities for core, with parents', () => {
    const entries = toRegistryEntries(view);
    for (const e of entries) expect(() => RegistryEntrySchema.parse(e)).not.toThrow();
    expect(entries).toContainEqual({ kind: 'area', id: 'kitchen', name: 'Kitchen', parentId: 'ground' });
    expect(entries).toContainEqual({ kind: 'device', id: 'dev_lamp', name: 'Reading lamp', parentId: 'living_room' });
    expect(entries).toContainEqual({
      kind: 'entity',
      id: 'cover.garage_door',
      name: 'cover.garage_door',
      parentId: 'garage',
      scopes: { domain: 'cover', area: 'garage' },
      attrs: { device_id: 'dev_garage', device_class: 'garage' },
    });
  });
});

describe('target resolution (HA §7 phase 4)', () => {
  it('expands areas, devices, floors and labels to concrete entities', () => {
    expect(ids({ area_id: ['living_room'] })).toEqual(['light.ceiling', 'light.reading_lamp']);
    expect(ids({ device_id: ['dev_lamp'] })).toEqual(['light.moved', 'light.reading_lamp']);
    expect(ids({ floor_id: ['top'] })).toEqual([]);
    expect(ids({ floor_id: ['ground'] })).toEqual([
      'light.ceiling',
      'light.kitchen',
      'light.moved',
      'light.reading_lamp',
    ]);
    // A label covers entities labelled directly, and those in a labelled area or device.
    expect(ids({ label_id: ['outdoor'] }, ANY)).toEqual(['cover.garage_door', 'switch.porch']);
  });

  it('follows an integration filter, so integration services find their entities in a room', () => {
    const withPlayers = buildView({
      ...raw,
      entities: [
        ...raw.entities,
        { entity_id: 'media_player.sonos', platform: 'sonos', area_id: 'living_room' },
        { entity_id: 'media_player.tv', platform: 'cast', area_id: 'living_room' },
      ],
    });
    const sonos: EntityFilter = [{ integration: 'sonos', domain: ['media_player'] }];
    expect(resolveTarget(withPlayers, { area_id: ['living_room'] }, sonos).map((t) => t.id)).toEqual([
      'media_player.sonos',
    ]);
    // Alternatives are OR'd.
    expect(
      resolveTarget(withPlayers, { area_id: ['living_room'] }, [{ integration: 'sonos' }, { domain: ['light'] }]).map(
        (t) => t.id,
      ),
    ).toEqual(['light.ceiling', 'light.reading_lamp', 'media_player.sonos']);
  });

  it("only reaches the service's domain through areas, devices, floors and labels", () => {
    expect(ids({ area_id: ['garage'] }, only('light'))).toEqual([]);
    expect(ids({ area_id: ['garage'] }, only('cover'))).toEqual(['cover.garage_door']);
    expect(ids({ label_id: ['outdoor'] }, only('switch'))).toEqual(['switch.porch']);
    // homeassistant.turn_on and friends act on any domain.
    expect(ids({ area_id: ['living_room'] }, ANY)).toEqual(['light.ceiling', 'light.reading_lamp']);
    // Entities named directly are kept as given.
    expect(ids({ entity_id: ['cover.garage_door'] }, only('light'))).toEqual(['cover.garage_door']);
  });

  it('dedupes a mix of direct entities and an area, and names and scopes each target', () => {
    expect(
      resolveTarget(view, { entity_id: ['light.ceiling', 'light.kitchen'], area_id: ['living_room'] }, only('light')),
    ).toEqual([
      {
        kind: 'entity',
        id: 'light.ceiling',
        name: 'Living Room Ceiling',
        scopes: { domain: 'light', area: 'living_room' },
      },
      { kind: 'entity', id: 'light.kitchen', name: 'light.kitchen', scopes: { domain: 'light', area: 'kitchen' } },
      {
        kind: 'entity',
        id: 'light.reading_lamp',
        name: 'Reading Lamp',
        scopes: { domain: 'light', area: 'living_room' },
      },
    ]);
  });

  it('treats entity_id "all" as every entity of the service domain', () => {
    expect(ids({ entity_id: ['all'] }, only('light'))).toEqual([
      'light.ceiling',
      'light.kitchen',
      'light.moved',
      'light.reading_lamp',
    ]);
  });

  it.each([
    [{ area_id: ['nowhere'] }, /Unknown area: nowhere/],
    [{ entity_id: ['light.gone'] }, /Unknown entity: light.gone/],
    [{ device_id: ['dev_x'] }, /Unknown device/],
    [{ floor_id: ['roof'] }, /Unknown floor/],
    [{ label_id: ['secret'] }, /Unknown label/],
  ])('fails closed on %j', (target, message) => {
    expect(() => resolveTarget(view, target, only('light'))).toThrow(message);
    try {
      resolveTarget(view, target, only('light'));
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCodes.TargetResolutionFailed);
    }
  });

  it('resolves no target to no entities', () => {
    expect(resolveTarget(view, undefined, only('light'))).toEqual([]);
  });
});

describe('normalizeServiceParams', () => {
  it('moves top-level target keys into target, as deduplicated lists', () => {
    expect(
      normalizeServiceParams({
        entity_id: 'light.a, light.b',
        brightness: 10,
        target: { entity_id: ['light.a'], area_id: 'kitchen' },
      }),
    ).toEqual({ brightness: 10, target: { entity_id: ['light.a', 'light.b'], area_id: ['kitchen'] } });
    expect(normalizeServiceParams({ brightness: 10 })).toEqual({ brightness: 10 });
    expect(normalizeServiceParams(undefined)).toEqual({});
  });

  it.each([
    ['a list', [1]],
    ['a string target', { target: 'light.a' }],
    ['a non-string id', { entity_id: 5 }],
    ['an unknown target key', { target: { room: 'x' } }],
  ])('rejects %s', (_name, params) => {
    expect(() => normalizeServiceParams(params)).toThrow();
  });
});
