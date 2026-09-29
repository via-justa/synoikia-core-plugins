import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import type { InitParams, PluginHandlers, ResolvedTarget } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeAssistantPlugin } from '../src/plugin.js';
import { configHash } from '../src/transform.js';
import { FAKE_TOKEN, startFakeHa } from './fake-ha.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const fake = await startFakeHa();
  cleanup.push(() => fake.close());
  const plugin = createHomeAssistantPlugin();
  cleanup.push(() => plugin.shutdown?.());
  const init: Omit<InitParams, 'sdkVersion'> = {
    instanceId: 'ha',
    config: { baseUrl: fake.url },
    secrets: { token: FAKE_TOKEN },
  };
  await plugin.init({ ...init, sdkVersion: '1.0.0' });
  return { fake, plugin, init };
}

const resolve = (plugin: PluginHandlers, key: string, params?: unknown) =>
  plugin.resolveOperation({ fn: 'call', args: params === undefined ? [key] : [key, params] });

/** What core does before `invoke`: resolve, resolve targets, prepare config writes. */
async function gate(plugin: PluginHandlers, key: string, params?: unknown) {
  const r = await resolve(plugin, key, params);
  const targets = await plugin.resolveTargets!({ key: r.key, params: r.params });
  const prepared =
    r.key.startsWith('config/') && r.key.endsWith('/update')
      ? await plugin.prepareWrite!({ key: r.key, params: r.params })
      : undefined;
  const summary = await plugin.summarize({ key: r.key, params: prepared?.params ?? r.params, targets });
  return { ...r, targets, prepared, summary };
}

const invoke = (
  plugin: PluginHandlers,
  key: string,
  params: unknown,
  extra: { targets?: ResolvedTarget[]; expectedHash?: string } = {},
) => plugin.invoke({ key, params, context: { callId: 'c1', deadlineMs: 5000, targets: [], ...extra } });

describe('Home Assistant plugin', () => {
  it('passes the SDK conformance checks against a (fake) Home Assistant', async () => {
    const { plugin, init } = await setup();
    const issues = await checkConformance({
      manifest,
      handlers: plugin,
      init,
      samples: [
        { fn: 'call', args: ['get_states'], expectKey: 'get_states' },
        { fn: 'call', args: ['light.turn_on', { area_id: 'living_room' }], expectKey: 'light.turn_on' },
        { fn: 'call', args: ['cover.open_cover', { entity_id: 'cover.blinds' }], expectKey: 'cover.open_cover' },
        { fn: 'call', args: ['cover.open_cover', { area_id: 'garage' }], expectKey: 'cover.open_cover#garage' },
        { fn: 'call', args: ['cover.toggle', { entity_id: 'cover.garage_door' }], expectKey: 'cover.toggle#garage' },
        { fn: 'call', args: ['lock.unlock', { entity_id: 'lock.front_door' }], expectKey: 'lock.unlock' },
        {
          fn: 'call',
          args: ['homeassistant.turn_off', { entity_id: 'lock.front_door' }],
          expectKey: 'homeassistant.turn_off#protected',
        },
        {
          fn: 'call',
          args: ['homeassistant.turn_on', { area_id: 'garage' }],
          expectKey: 'homeassistant.turn_on#protected',
        },
        { fn: 'call', args: ['homeassistant.toggle', { area_id: 'kitchen' }], expectKey: 'homeassistant.toggle' },
        {
          fn: 'call',
          args: ['config/automation/config/get', { id: 'morning' }],
          expectKey: 'config/automation/config/get',
        },
      ],
      rejects: [
        { fn: 'call', args: ['light.explode', {}] },
        { fn: 'call', args: ['ws_command', { type: 'auth/delete_all_refresh_tokens' }] },
        { fn: 'call', args: ['cover.open_cover#garage', {}] },
        { fn: 'call', args: ['light.turn_on', 'light.kitchen'] },
        { fn: 'call', args: [42] },
        { fn: 'other', args: ['get_states'] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the catalog, the version and the registry', async () => {
    const { plugin } = await setup();
    const { upstreamVersion, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe('2026.9.1');
    expect(operations.find((o) => o.key === 'lock.unlock')).toMatchObject({ locked: true });
    const registry = await plugin.syncRegistry!();
    expect(registry).toContainEqual(
      expect.objectContaining({
        kind: 'entity',
        id: 'light.ceiling',
        name: 'Living Room Ceiling',
        parentId: 'living_room',
      }),
    );
    expect(registry.filter((e) => e.kind === 'area')).toHaveLength(4);
    expect(await plugin.testConnection()).toEqual({ ok: true, upstreamVersion: '2026.9.1' });
  });

  it('reports a bad token from testConnection instead of throwing', async () => {
    const { plugin, fake } = await setup();
    await plugin.init({
      instanceId: 'ha',
      config: { baseUrl: fake.url },
      secrets: { token: 'nope' },
      sdkVersion: '1.0.0',
    });
    expect(await plugin.testConnection()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/rejected the access token/),
    });
  });

  it('requires a URL and a token', () => {
    const plugin = createHomeAssistantPlugin();
    expect(() => plugin.init({ instanceId: 'x', config: {}, secrets: { token: 't' }, sdkVersion: '1.0.0' })).toThrow(
      /baseUrl/,
    );
    expect(() =>
      plugin.init({ instanceId: 'x', config: { baseUrl: 'http://ha' }, secrets: {}, sdkVersion: '1.0.0' }),
    ).toThrow(/token/);
  });

  it('resolves targets to friendly, scoped entities and summarizes with their names', async () => {
    const { plugin } = await setup();
    const g = await gate(plugin, 'light.turn_on', { area_id: 'living_room', brightness: 120 });
    expect(g.params).toEqual({ brightness: 120, target: { area_id: ['living_room'] } });
    expect(g.targets.map((t) => [t.id, t.name, t.scopes])).toEqual([
      ['light.ceiling', 'Living Room Ceiling', { domain: 'light', area: 'living_room' }],
      ['light.reading_lamp', 'Reading Lamp', { domain: 'light', area: 'living_room' }],
    ]);
    expect(g.summary).toEqual({
      text: 'Turn on (light.turn_on) on Living Room Ceiling, Reading Lamp with {"brightness":120}',
    });
    await expect(gate(plugin, 'light.turn_on', { area_id: 'nowhere' })).rejects.toMatchObject({
      code: ErrorCodes.TargetResolutionFailed,
    });
  });

  it("finds an integration service's entities in a room, by its target selector", async () => {
    const { plugin } = await setup();
    expect((await gate(plugin, 'sonos.snapshot', { area_id: 'living_room' })).targets.map((t) => t.id)).toEqual([
      'media_player.sonos_living',
    ]);
    // A service with no filter (homeassistant.turn_on) covers every domain in the room.
    expect((await gate(plugin, 'homeassistant.turn_on', { area_id: 'living_room' })).targets.map((t) => t.id)).toEqual([
      'climate.thermostat',
      'cover.blinds',
      'light.ceiling',
      'light.reading_lamp',
      'media_player.sonos_living',
      'media_player.tv',
    ]);
  });

  it('locks scenes that would unlock, disarm or open something, or set an unknown entity', async () => {
    const { plugin } = await setup();
    const key = async (op: string, params: unknown) => (await resolve(plugin, op, params)).key;
    expect(await key('scene.apply', { entities: { 'lock.front_door': 'unlocked', 'light.kitchen': 'on' } })).toBe(
      'scene.apply#protected',
    );
    expect(await key('scene.apply', { entities: { 'cover.garage_door': { state: 'open' } } })).toBe(
      'scene.apply#protected',
    );
    expect(await key('scene.apply', { entities: { 'lock.made_up': 'unlocked' } })).toBe('scene.apply#protected');
    expect(await key('scene.apply', { entities: { 'light.kitchen': 'on', 'cover.blinds': 'open' } })).toBe(
      'scene.apply',
    );
    await expect(key('scene.apply', { entities: ['lock.front_door'] })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    // A stored scene is looked through: Leaving includes the front door lock, Movie night doesn't.
    expect(await key('scene.turn_on', { entity_id: 'scene.leaving' })).toBe('scene.turn_on#protected');
    expect(await key('scene.turn_on', { entity_id: 'scene.movie' })).toBe('scene.turn_on');
    expect(
      (
        await gate(plugin, 'scene.apply', {
          entities: { 'lock.front_door': 'unlocked', 'light.kitchen': 'on', 'lock.made_up': 'x' },
        })
      ).summary.confirmLiteral,
    ).toBe('Front Door, lock.made_up');
    expect((await gate(plugin, 'scene.turn_on', { entity_id: 'scene.leaving' })).summary.confirmLiteral).toBe(
      'Leaving',
    );
  });

  it('asks for the name of what a locked operation affects', async () => {
    const { plugin } = await setup();
    expect((await gate(plugin, 'lock.unlock', { entity_id: 'lock.front_door' })).summary).toEqual({
      text: 'Unlock (lock.unlock) on Front Door',
      confirmLiteral: 'Front Door',
    });
    expect((await gate(plugin, 'cover.open_cover', { area_id: 'garage' })).summary).toMatchObject({
      text: expect.stringContaining('(a garage door or gate)'),
      confirmLiteral: 'Garage Door',
    });
    expect((await gate(plugin, 'homeassistant.restart')).summary.confirmLiteral).toBe('Home Sweet Home');
    expect(
      (await gate(plugin, 'homeassistant.turn_off', { entity_id: ['lock.front_door', 'switch.porch'] })).summary,
    ).toMatchObject({
      text: expect.stringContaining('(a lock, alarm panel, garage door or gate)'),
      confirmLiteral: 'Front Door, Porch Light',
    });
    expect((await gate(plugin, 'config/automation/config/delete', { id: 'morning' })).summary.confirmLiteral).toBe(
      'Morning lights',
    );
    expect((await gate(plugin, 'config/area_registry/delete', { area_id: 'attic' })).summary.confirmLiteral).toBe(
      'Attic',
    );
    expect(
      (await gate(plugin, 'light.turn_on', { entity_id: 'light.kitchen' })).summary.confirmLiteral,
    ).toBeUndefined();
  });

  it('acts on exactly the approved targets, never the original area', async () => {
    const { plugin, fake } = await setup();
    await resolve(plugin, 'light.turn_on', {}); // load the catalog
    const approved = [{ kind: 'entity', id: 'light.ceiling', name: 'Living Room Ceiling', scopes: {} }];
    await invoke(
      plugin,
      'light.turn_on',
      { brightness: 10, target: { area_id: ['living_room'] }, best_practice_key: 'x' },
      { targets: approved },
    );
    expect(fake.calls.at(-1)).toEqual({
      type: 'call_service',
      payload: {
        domain: 'light',
        service: 'turn_on',
        service_data: { brightness: 10 },
        target: { entity_id: ['light.ceiling'] },
      },
    });
    await expect(invoke(plugin, 'light.turn_on', { target: { area_id: ['attic'] } })).rejects.toMatchObject({
      code: ErrorCodes.TargetResolutionFailed,
    });
    // A locked #garage key calls the real service; a service with a response returns it.
    await invoke(
      plugin,
      'cover.open_cover#garage',
      { target: { entity_id: ['cover.garage_door'] } },
      {
        targets: [{ kind: 'entity', id: 'cover.garage_door', name: 'Garage Door', scopes: {} }],
      },
    );
    expect(fake.calls.at(-1)?.payload).toMatchObject({ domain: 'cover', service: 'open_cover' });
    expect(
      await invoke(
        plugin,
        'weather.get_forecasts',
        { target: { entity_id: ['weather.home'] } },
        {
          targets: [{ kind: 'entity', id: 'weather.home', name: 'Home', scopes: {} }],
        },
      ),
    ).toEqual({ 'weather.home': { forecast: [] } });
    await expect(invoke(plugin, 'climate.set_temperature', { temperature: 99 })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });

  it('edits an automation with a patch against its config_hash, and shows the diff', async () => {
    const { plugin, fake } = await setup();
    const read = (await invoke(plugin, 'config/automation/config/get', { id: 'morning' })) as {
      config: unknown;
      config_hash: string;
    };
    expect(read.config_hash).toBe(configHash(fake.automations.get('morning')));
    const g = await gate(plugin, 'config/automation/config/update', {
      id: 'morning',
      config_hash: read.config_hash,
      patch: [{ op: 'replace', path: '/alias', value: 'Sunrise lights' }],
      best_practice_key: 'k',
    });
    expect(g.prepared).toMatchObject({
      params: { id: 'morning', config: { alias: 'Sunrise lights' } },
      diff: [{ path: '/alias', before: 'Morning lights', after: 'Sunrise lights' }],
      expectedHash: read.config_hash,
    });
    await invoke(plugin, g.key, g.prepared!.params, { expectedHash: g.prepared!.expectedHash });
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Sunrise lights', mode: 'single' });
  });

  it('refuses a stale config_hash before approval, and a change made while waiting at write time', async () => {
    const { plugin, fake } = await setup();
    const params = { id: 'morning', config_hash: 'stale', patch: [{ op: 'replace', path: '/mode', value: 'restart' }] };
    await expect(gate(plugin, 'config/automation/config/update', params)).rejects.toMatchObject({
      code: ErrorCodes.ConfigConflict,
    });
    const hash = configHash(fake.automations.get('morning'));
    const g = await gate(plugin, 'config/automation/config/update', { ...params, config_hash: hash });
    // Someone edits the automation in the HA UI while the approval is open.
    fake.automations.set('morning', { ...fake.automations.get('morning'), alias: 'Edited in the UI' });
    await expect(
      invoke(plugin, g.key, g.prepared!.params, { expectedHash: g.prepared!.expectedHash }),
    ).rejects.toMatchObject({
      code: ErrorCodes.ConfigConflict,
    });
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Edited in the UI', mode: 'single' });
  });

  it('creates new config objects but never overwrites an existing one', async () => {
    const { plugin, fake } = await setup();
    expect(
      await invoke(plugin, 'config/automation/config/create', { id: 'porch', config: { alias: 'Porch' } }),
    ).toEqual({ id: 'porch' });
    expect(fake.automations.get('porch')).toEqual({ alias: 'Porch', id: 'porch' });
    await expect(
      invoke(plugin, 'config/automation/config/create', { id: 'morning', config: { alias: 'x' } }),
    ).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringMatching(/already exists; use config\/automation\/config\/update/),
    });
    await expect(invoke(plugin, 'config/script/config/get', { id: '../../x' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });

  it('edits a dashboard the same way', async () => {
    const { plugin, fake } = await setup();
    const read = (await invoke(plugin, 'lovelace/config', {})) as { config_hash: string };
    const prepared = await plugin.prepareWrite!({
      key: 'lovelace/config/save',
      params: { config_hash: read.config_hash, patch: [{ op: 'replace', path: '/title', value: 'House' }] },
    });
    expect(prepared.diff).toEqual([{ path: '/title', before: 'Home', after: 'House' }]);
    await invoke(plugin, 'lovelace/config/save', prepared.params, { expectedHash: prepared.expectedHash });
    expect(fake.dashboard.config.title).toBe('House');
  });

  it('filters states instead of dumping everything', async () => {
    const { plugin } = await setup();
    const ids = async (params: unknown) =>
      ((await invoke(plugin, 'get_states', params)) as { entity_id: string }[]).map((s) => s.entity_id);
    expect(await ids({ domain: 'lock' })).toEqual(['lock.front_door']);
    expect(await ids({ area: 'living_room', domain: ['light'] })).toEqual(['light.reading_lamp', 'light.ceiling']);
    expect(await ids({ entity_id: 'switch.porch' })).toEqual(['switch.porch']);
  });

  it('hands out guides for attestation-required operations only', async () => {
    const { plugin } = await setup();
    const guide = await plugin.getGuide!({ key: 'config/automation/config/create' });
    expect(guide).toMatchObject({
      version: expect.stringMatching(/^[0-9a-f]{12}$/),
      content: expect.stringContaining('Automation best practices'),
    });
    expect(await plugin.getGuide!({ key: 'config/automation/config/update' })).toEqual(guide);
    await expect(plugin.getGuide!({ key: 'light.turn_on' })).rejects.toMatchObject({
      code: ErrorCodes.UnknownOperation,
    });
  });

  it('refreshes targets after a registry event', async () => {
    const { plugin, fake } = await setup();
    const living = async () =>
      (await gate(plugin, 'light.turn_on', { area_id: 'living_room' })).targets.map((t) => t.id);
    expect(await living()).toEqual(['light.ceiling', 'light.reading_lamp']);
    fake.moveEntity('light.kitchen', 'living_room');
    expect(await living()).toEqual(['light.ceiling', 'light.reading_lamp']); // cached
    fake.emit('entity_registry_updated', { action: 'update', entity_id: 'light.kitchen' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await living()).toEqual(['light.ceiling', 'light.kitchen', 'light.reading_lamp']);
  });

  it('asks core to re-sync when Home Assistant loads a new integration', async () => {
    const { plugin, fake } = await setup();
    const send = vi.fn();
    const original = process.send;
    process.send = send as typeof process.send;
    cleanup.push(() => {
      process.send = original;
    });
    await resolve(plugin, 'light.turn_on', {}); // connects, which subscribes to events
    fake.emit('component_loaded', { component: 'hue' });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'catalogChanged',
        params: { reason: 'component_loaded' },
      }),
    );
  });
});
