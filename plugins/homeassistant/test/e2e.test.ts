import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, startFakeHa } from './fake-ha.js';
import type { FakeHa } from './fake-ha.js';

/**
 * The real core running this plugin's built bundle (a permission-confined child) against a fake Home
 * Assistant over WebSocket and REST, through core's plugin harness (design §13 phase 19).
 */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeHa;

beforeAll(async () => {
  fake = await startFakeHa();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    slug: 'ha',
    connection: { baseUrl: fake.url, token: FAKE_TOKEN },
  });
}, 30_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

const lastServiceCall = () => fake.calls.filter((c) => c.type === 'call_service').at(-1)?.payload;

describe('Home Assistant plugin end to end (fake Home Assistant)', () => {
  it('syncs the catalog and the registry; every domain starts at Read', () => {
    expect(h.operation('lock.unlock')).toMatchObject({ locked: true, classification: 'write' });
    expect(h.operation('cover.open_cover#garage')).toMatchObject({ locked: true });
    expect(h.operation('config/automation/config/update')).toMatchObject({ kind: 'config', attestationRequired: true });
    expect(h.instance()).toMatchObject({ upstreamVersion: '2026.9.1', lastSyncStatus: 'ok' });
    expect(h.registry().find((e) => e.extId === 'light.ceiling')).toMatchObject({
      kind: 'entity',
      name: 'Living Room Ceiling',
      parentExtId: 'living_room',
    });
  });

  it('reads states with camera tokens redacted, and hides service calls at Read', async () => {
    const states = await h.execute(`return await ha.call('get_states', { domain: 'camera' });`);
    expect(JSON.stringify(states)).not.toContain('cam-secret-token-123');
    expect(states).toMatchObject({
      ok: true,
      value: [{ entity_id: 'camera.driveway', attributes: { access_token: '[REDACTED]' } }],
    });
    // At Read a group's writes are off (new groups start at Ask in newer core).
    h.setGroupLevel('light', 'read');
    await expect(h.execute(`return await ha.call('light.turn_on', { area_id: 'kitchen' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED' },
    });
  });

  it('asks before lighting a room, naming the entities, and acts on exactly those', async () => {
    h.setGroupLevel('light', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `await ha.call('light.turn_on', { area_id: 'living_room', brightness: 80 }); return 'done';`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: 'done' });
    expect(shown[0]).toContain('on Living Room Ceiling, Reading Lamp');
    expect(lastServiceCall()).toEqual({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness: 80 },
      target: { entity_id: ['light.ceiling', 'light.reading_lamp'] },
    });
  });

  it('auto-approves under an area rule only when every target is in the area', async () => {
    h.addRule({
      operation: 'light.turn_off',
      match: [{ field: '$targets', scopes: { area: ['living_room'] } }],
      reason: 'living room lights',
    });
    const inside = await h.execute(`await ha.call('light.turn_off', { area_id: 'living_room' }); return 'off';`);
    expect(inside).toMatchObject({ ok: true, value: 'off' });
    // One kitchen light as well: the rule doesn't cover it, so a human is asked (and here, nobody can be).
    const mixed = await h.execute(
      `return await ha.call('light.turn_off', { area_id: 'living_room', entity_id: 'light.kitchen' });`,
    );
    expect(mixed).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.audit({ operationKey: 'light.turn_off' }).map((a) => a.decision)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'denied']),
    );
  });

  it('needs the garage door typed back to open it, and never auto-approves it', async () => {
    h.setGroupLevel('cover', 'ask');
    h.setOperationLevel('cover.open_cover#garage', 'ask');
    const attempts: string[] = [];
    const r = await h.execute(`await ha.call('cover.open_cover', { area_id: 'garage' }); return 'open';`, {
      onApproval: (a) => {
        try {
          a.approve('garage');
        } catch (err) {
          attempts.push((err as Error).message);
          a.approve('Garage Door');
        }
      },
    });
    expect(attempts[0]).toMatch(/Type "Garage Door" exactly/);
    expect(r).toMatchObject({ ok: true, value: 'open' });
    expect(lastServiceCall()).toMatchObject({ service: 'open_cover', target: { entity_id: ['cover.garage_door'] } });
  });

  it('edits an automation: guide first, then an approval with the diff, and a conflict if HA changed meanwhile', async () => {
    h.setGroupLevel('automation', 'ask');
    const read = `const { config_hash } = await ha.call('config/automation/config/get', { id: 'morning' });`;
    const patch = `patch: [{ op: 'replace', path: '/alias', value: 'Sunrise lights' }]`;
    // No guide read yet: refused before anything else.
    await expect(
      h.execute(
        `${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, ${patch} });`,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    const guide = await h.search(`return await guides.get('config/automation/config/update');`);
    const key = (guide as { value: { best_practice_key: string } }).value.best_practice_key;
    expect(key).toBeTruthy();

    const diffs: unknown[] = [];
    const ok = await h.execute(
      `${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, best_practice_key: '${key}', ${patch} });`,
      {
        onApproval: (a) => {
          diffs.push(a.pending.diff);
          a.approve();
        },
      },
    );
    expect(ok).toMatchObject({ ok: true, value: { id: 'morning' } });
    expect(diffs[0]).toEqual([{ path: '/alias', before: 'Morning lights', after: 'Sunrise lights' }]);
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Sunrise lights' });

    // Someone edits the automation in the HA UI while the approval is open.
    const conflict = await h.execute(
      `${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, best_practice_key: '${key}', patch: [{ op: 'replace', path: '/mode', value: 'restart' }] });`,
      {
        onApproval: (a) => {
          fake.automations.set('morning', { ...fake.automations.get('morning'), alias: 'Edited in the UI' });
          a.approve();
        },
      },
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFIG_CONFLICT' } });
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Edited in the UI', mode: 'single' });
  });

  it('reports a Home Assistant permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('history/history_during_period');
    await expect(
      h.execute(
        `return await ha.call('history/history_during_period', { start_time: '2026-09-01T00:00:00Z', entity_ids: ['light.kitchen'] });`,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UPSTREAM_DENIED' } });
    fake.denied.delete('history/history_during_period');
  });

  it('loads under the permission model and reports an unreachable Home Assistant cleanly', async () => {
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', token: 't' })).resolves.toMatchObject({
      ok: false,
    });
  });
});
