import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createTrueNasPlugin } from '../src/plugin.js';
import { FAKE_API_KEY, startFakeTrueNas } from './fake-truenas.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const fake = await startFakeTrueNas();
  cleanup.push(() => fake.close());
  const plugin = createTrueNasPlugin();
  cleanup.push(() => plugin.shutdown?.());
  const init = { instanceId: 'nas', config: { baseUrl: fake.url }, secrets: { apiKey: FAKE_API_KEY } };
  await plugin.init({ ...init, sdkVersion: '1.0.0' });
  return { fake, plugin, init };
}

const invoke = (plugin: PluginHandlers, key: string, params: unknown[], deadlineMs = 5000) =>
  plugin.invoke({ key, params, context: { callId: 'c1', deadlineMs } });

describe('TrueNAS plugin', () => {
  it('passes the SDK conformance checks against a (fake) TrueNAS', async () => {
    const { plugin, init } = await setup();
    const issues = await checkConformance({
      manifest,
      handlers: plugin,
      init,
      samples: [
        { fn: 'call', args: ['pool.query', []], expectKey: 'pool.query' },
        { fn: 'call', args: ['pool.dataset.create', { name: 'tank/media/tv' }], expectKey: 'pool.dataset.create' },
        { fn: 'call', args: ['pool.dataset.delete', 'tank/media'], expectKey: 'pool.dataset.delete' },
        { fn: 'call', args: ['pool.export', 1], expectKey: 'pool.export' },
        { fn: 'call', args: ['user.delete', 70], expectKey: 'user.delete' },
        { fn: 'call', args: ['system.reboot'], expectKey: 'system.reboot' },
        { fn: 'call', args: ['filesystem.setacl', { path: '/mnt/tank' }], expectKey: 'filesystem.setacl#pool-root' },
        { fn: 'call', args: ['filesystem.setacl', { path: '/mnt/tank/media' }], expectKey: 'filesystem.setacl' },
        {
          fn: 'call',
          args: ['filesystem.setacl', { path: '/mnt/tank/media/..' }],
          expectKey: 'filesystem.setacl#pool-root',
        },
        { fn: 'call', args: ['filesystem.chown', { path: '/mnt/tank/.' }], expectKey: 'filesystem.chown#pool-root' },
      ],
      rejects: [
        { fn: 'call', args: ['no.such.method'] },
        { fn: 'call', args: [42] },
        { fn: 'call', args: ['auth.login_with_api_key', 'x'] },
        { fn: 'call', args: ['core.bulk', 'pool.dataset.delete', [['tank/media']]] },
        { fn: 'call', args: ['core.download', 'config.save', [], 'config.db'] },
        { fn: 'other', args: ['pool.query'] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('reports connection problems from testConnection instead of throwing', async () => {
    const { plugin, fake } = await setup();
    expect(await plugin.testConnection()).toEqual({ ok: true, upstreamVersion: 'TrueNAS-25.04.2' });
    await plugin.init({
      instanceId: 'nas',
      config: { baseUrl: fake.url },
      secrets: { apiKey: 'wrong-key' },
      sdkVersion: '1.0.0',
    });
    expect(await plugin.testConnection()).toMatchObject({ ok: false, message: expect.stringMatching(/rejected/) });
  });

  it('requires a URL and an API key', async () => {
    const plugin = createTrueNasPlugin();
    expect(() => plugin.init({ instanceId: 'x', config: {}, secrets: { apiKey: 'k' }, sdkVersion: '1.0.0' })).toThrow(
      /baseUrl/,
    );
    expect(() =>
      plugin.init({ instanceId: 'x', config: { baseUrl: 'https://nas' }, secrets: {}, sdkVersion: '1.0.0' }),
    ).toThrow(/apiKey/);
  });

  it('asks for the name of what a locked operation destroys', async () => {
    const { plugin } = await setup();
    await plugin.syncCatalog();
    const literal = async (fn: string, ...params: unknown[]) => {
      const r = await plugin.resolveOperation({ fn: 'call', args: [fn, ...params] });
      return (await plugin.summarize({ key: r.key, params: r.params, targets: [] })).confirmLiteral;
    };
    expect(await literal('pool.dataset.delete', 'tank/media', { recursive: true })).toBe('tank/media');
    expect(await literal('pool.export', 1)).toBe('tank');
    expect(await literal('pool.export', 99)).toBe('99'); // lookup failed: the raw id
    expect(await literal('user.delete', 70)).toBe('alice');
    expect(await literal('user.set_password', { username: 'bob', new_password: '[REDACTED]' })).toBe('bob');
    expect(await literal('disk.wipe', 'sda', 'QUICK')).toBe('sda');
    expect(await literal('system.reboot')).toBe('nas01');
    expect(await literal('pool.dataset.export_key', 'tank/secure')).toBe('tank/secure');
    expect(await literal('app.delete', 'plex', { remove_images: true })).toBe('plex');
    // The user the key acts as, not its model-chosen name; without one, the hostname.
    expect(await literal('api_key.create', { name: 'read-only-viewer', username: 'root' })).toBe('root');
    expect(await literal('api_key.create', { name: 'ci' })).toBe('nas01');
    expect(await literal('api_key.delete', 3)).toBe('backup-bot');
    expect(await literal('api_key.query')).toBe('nas01');
    expect(await literal('auth.generate_token')).toBe('nas01');
    expect(await literal('filesystem.chown', { path: '/mnt/tank', uid: 0 })).toBe('/mnt/tank');
    expect(await literal('pool.dataset.create', { name: 'tank/x' })).toBeUndefined();
    const summary = await plugin.summarize({ key: 'pool.dataset.create', params: [{ name: 'tank/x' }], targets: [] });
    expect(summary.text).toBe('TrueNAS pool.dataset.create({"name":"tank/x"})');
  });

  it('invokes methods with positional params and waits for jobs', async () => {
    const { plugin, fake } = await setup();
    await plugin.syncCatalog();
    expect(await invoke(plugin, 'pool.dataset.create', [{ name: 'tank/media/tv' }])).toMatchObject({
      name: 'tank/media/tv',
    });
    expect(fake.datasets.has('tank/media/tv')).toBe(true);
    expect(await invoke(plugin, 'app.upgrade', ['plex', {}])).toEqual({ name: 'plex', upgraded: true });
    expect(fake.calls.some((c) => c.method === 'core.get_jobs')).toBe(true);
    // The #pool-root key calls the real method.
    await invoke(plugin, 'filesystem.setacl#pool-root', [{ path: '/mnt/tank' }]);
    expect(fake.calls.at(-1)).toEqual({ method: 'filesystem.setacl', params: [{ path: '/mnt/tank' }] });
  });

  it('masks new API keys and tokens, and keeps positional passwords out of summaries', async () => {
    const { plugin } = await setup();
    await plugin.syncCatalog();
    expect(await invoke(plugin, 'api_key.create', [{ name: 'ci', username: 'root' }])).toEqual({
      id: 4,
      name: 'ci',
      key: '[REDACTED]',
    });
    expect(await invoke(plugin, 'auth.generate_token', [])).toBe('[REDACTED]');
    expect(await invoke(plugin, 'pool.dataset.export_key', ['tank/secure'])).toBe('[REDACTED]');
    const summary = await plugin.summarize({
      key: 'user.setup_local_administrator',
      params: ['truenas_admin', 'hunter2-secret'],
      targets: [],
    });
    expect(summary.text).not.toContain('hunter2-secret');
    expect(summary.text).toContain('"truenas_admin","[REDACTED]"');
    expect(summary.confirmLiteral).toBe('truenas_admin');
    const create = await plugin.summarize({
      key: 'pool.dataset.create',
      params: [{ name: 'tank/secure', encryption_options: { key: 'abcdef0123456789-key-secret' } }],
      targets: [],
    });
    expect(create.text).not.toContain('key-secret');
    expect(create.text).toContain('"key":"[REDACTED]"');
  });

  it('masks the keytab contents, which core cannot recognize by key name', async () => {
    const { plugin } = await setup();
    expect(await invoke(plugin, 'kerberos.keytab.query', [])).toEqual([
      { id: 1, name: 'AD_MACHINE_ACCOUNT', file: '[REDACTED]' },
    ]);
  });

  it('surfaces a permission denial as UPSTREAM_DENIED', async () => {
    const { plugin, fake } = await setup();
    fake.denied.add('user.query');
    await expect(invoke(plugin, 'user.query', [])).rejects.toMatchObject({ code: ErrorCodes.UpstreamDenied });
  });

  it('works after a restart without a fresh sync (the catalog is loaded on demand)', async () => {
    const { plugin } = await setup();
    expect(await plugin.resolveOperation({ fn: 'call', args: ['pool.query'] })).toEqual({
      key: 'pool.query',
      params: [],
    });
    expect(await invoke(plugin, 'pool.query', [])).toEqual([{ id: 1, name: 'tank', status: 'ONLINE' }]);
  });

  it('offers installed apps for the app.upgrade rule picker', async () => {
    const { plugin } = await setup();
    expect(await plugin.optionsFor!({ source: 'installed-apps' })).toEqual([
      { value: 'plex', label: 'plex' },
      { value: 'sonarr', label: 'sonarr' },
    ]);
    expect(await plugin.optionsFor!({ source: 'installed-apps', query: 'son' })).toHaveLength(1);
    await expect(plugin.optionsFor!({ source: 'nope' })).rejects.toBeInstanceOf(PluginError);
  });
});
