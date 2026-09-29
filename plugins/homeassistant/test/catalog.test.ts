import { OperationDescriptorSchema } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { buildCatalog, entityFilter, FIXED_COMMANDS, isServiceKey, LOCKED_SERVICES } from '../src/catalog.js';
import type { Services } from '../src/catalog.js';
import { SERVICES } from './fake-ha.js';

const catalog = buildCatalog(SERVICES as Services);
const op = (key: string) => catalog.operations.find((o) => o.key === key);

describe('classification (HA §2.3, §7 phase 1)', () => {
  it('classifies every service as a write, however harmless its name', () => {
    const services = catalog.operations.filter((o) => o.kind === 'service');
    expect(services.length).toBeGreaterThan(15);
    for (const s of services) expect(s.classification, s.key).toBe('write');
    // Even a service that only returns data (weather.get_forecasts) is a write until an admin says otherwise.
    expect(op('weather.get_forecasts')).toMatchObject({
      classification: 'write',
      classificationReason: 'call_service-default',
    });
  });

  it('locks the physical-safety and system-integrity services', () => {
    for (const key of [
      'lock.unlock',
      'alarm_control_panel.alarm_disarm',
      'homeassistant.restart',
      'homeassistant.stop',
    ])
      expect(op(key), key).toMatchObject({ locked: true, typedConfirmation: true });
    expect(op('lock.lock')).toMatchObject({ locked: false });
    expect(LOCKED_SERVICES.has('hassio.host_reboot')).toBe(true);
  });

  it('adds a locked #garage twin next to the services that open a cover', () => {
    for (const key of ['cover.open_cover', 'cover.toggle', 'cover.set_cover_position']) {
      expect(op(key), key).toMatchObject({ locked: false });
      expect(op(`${key}#garage`), key).toMatchObject({
        locked: true,
        group: 'cover',
        docs: { description: expect.stringContaining('garage door or gate') },
      });
    }
    expect(op('cover.close_cover#garage')).toBeUndefined();
  });

  it('adds a locked #protected twin to the generic homeassistant on/off/toggle', () => {
    for (const key of ['homeassistant.turn_on', 'homeassistant.turn_off', 'homeassistant.toggle']) {
      expect(op(key), key).toMatchObject({ locked: false });
      expect(op(`${key}#protected`), key).toMatchObject({
        locked: true,
        docs: { description: expect.stringContaining('a lock, an alarm panel, or a garage door') },
      });
    }
  });

  it('adds locked #protected twins for scenes', () => {
    expect(op('scene.apply#protected')).toMatchObject({ locked: true });
    expect(op('scene.turn_on#protected')).toMatchObject({ locked: true });
    expect(op('scene.apply')).toMatchObject({ locked: false });
  });

  it('seeds the fixed commands: reads, config writes, locked deletes, attestation', () => {
    expect(op('get_states')).toMatchObject({ classification: 'read', group: 'states' });
    expect(op('history/history_during_period')).toMatchObject({ classification: 'read', group: 'history' });
    expect(op('config/area_registry/list')).toMatchObject({ classification: 'read', group: 'area' });
    expect(op('config/automation/config/get')).toMatchObject({ classification: 'read', group: 'automation' });
    expect(op('config/automation/config/update')).toMatchObject({
      classification: 'write',
      kind: 'config',
      attestationRequired: true,
    });
    expect(op('config/automation/config/create')).toMatchObject({ kind: 'ws_command', attestationRequired: true });
    expect(op('lovelace/config/save')).toMatchObject({ kind: 'config', attestationRequired: false });
    for (const key of Object.keys(FIXED_COMMANDS).filter((k) => /\/(delete|remove)$/.test(k)))
      expect(op(key), key).toMatchObject({ locked: true, classification: 'write' });
    expect(op('config/area_registry/update')).toMatchObject({ locked: false });
  });

  it('produces valid descriptors with schemas, docs and match profiles', () => {
    for (const d of catalog.operations) expect(() => OperationDescriptorSchema.parse(d), d.key).not.toThrow();
    expect(op('light.turn_on')).toMatchObject({
      group: 'light',
      matchProfile: 'targets',
      docs: { summary: 'Turn on: Turns on one or more lights.' },
      paramsSchema: {
        properties: {
          brightness: { type: 'number', minimum: 0, maximum: 255 },
          flash: { enum: ['short', 'long'] }, // from a collapsible section
          target: { properties: { area_id: expect.any(Object) } },
        },
      },
    });
    expect(op('climate.set_temperature')).toMatchObject({ matchProfile: 'climate.set_temperature' });
    expect(op('homeassistant.restart')).not.toHaveProperty('matchProfile');
    expect(op('cover.set_cover_position')?.paramsSchema).toMatchObject({ required: ['position'] });
  });

  it('keeps only well-formed service names, and tells services from commands', () => {
    const odd = buildCatalog({ 'Bad Domain': { x: {} }, light: { 'turn on': {}, turn_on: {} } } as Services);
    expect(odd.services.has('light.turn_on')).toBe(true);
    expect([...odd.services.keys()]).toEqual(['light.turn_on']);
    expect(isServiceKey('light.turn_on')).toBe(true);
    expect(isServiceKey('cover.open_cover#garage')).toBe(true);
    expect(isServiceKey('get_states')).toBe(false);
    expect(isServiceKey('config/automation/config/get')).toBe(false);
  });

  it("reads a service's target selector as an entity filter, in either shape", () => {
    expect(entityFilter({ target: { entity: { domain: 'light' } } })).toEqual([{ domain: ['light'] }]);
    expect(entityFilter({ target: { entity: [{ integration: 'sonos', domain: ['media_player'] }] } })).toEqual([
      { integration: 'sonos', domain: ['media_player'] },
    ]);
    // No filter, or an alternative without one, means every entity.
    expect(entityFilter({ target: { entity: {} } })).toEqual([]);
    expect(entityFilter({ target: { entity: [{ domain: 'light' }, {}] } })).toEqual([]);
    expect(entityFilter({ target: {} })).toEqual([]);
    expect(entityFilter(undefined)).toEqual([]);
  });
});
