import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, HASH, SECRETS, startFakeQbittorrent } from './fake-qbittorrent.js';
import type { FakeQbittorrent } from './fake-qbittorrent.js';
import { CALL_SECRETS, HOST, LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake qBittorrent, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeQbittorrent;

beforeAll(async () => {
  fake = await startFakeQbittorrent();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

const call = (key: string, params?: unknown) =>
  `return await qbittorrent.call(${JSON.stringify(key)}${params === undefined ? '' : `, ${JSON.stringify(params)}`});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);
const SECRET_VALUES = [...Object.values(SECRETS), CREDENTIALS.password, ...CALL_SECRETS];

describe('qBittorrent end to end (fake qBittorrent)', () => {
  it('syncs the declared operations and hands the agent instructions to the MCP server', () => {
    expect(h.instance()).toMatchObject({ upstreamVersion: 'v5.2.4 (WebUI API 2.15.1)', lastSyncStatus: 'ok' });
    expect(h.operation('torrents.delete#with-files')).toMatchObject({ locked: true, typedConfirmation: true });
    const text = readFileSync(path.join(PLUGIN_DIR, 'instructions.md'), 'utf8').trim();
    expect(h.ctx.instances.runtime(h.instanceId).instructions).toBe(text);
    expect(text).toContain('qbittorrent.call(key, params)');
  });

  it('lists torrents and their trackers at Read, with passkeys masked', async () => {
    allow('torrents.info', 'read');
    const r = await h.execute(
      `const list = await qbittorrent.call('torrents.info', { filter: 'downloading' });
       const trackers = await qbittorrent.call('torrents.trackers', { hash: list[0].hash });
       return { name: list[0].name, trackers: trackers.map((t) => t.url) };`,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const value = (r as { value: { name: string; trackers: string[] } }).value;
    expect(value.name).toBe('Debian 12 Netinst');
    expect(value.trackers[1]).toMatch(/^https:\/\/private\.example\/<masked:[0-9a-f]{12}>$/);
    expect(JSON.stringify(r)).not.toContain(SECRETS.privatePasskey);
  });

  it('stops a torrent once a human approves it at Ask', async () => {
    h.setOperationLevel('torrents.stop', 'ask');
    const shown: string[] = [];
    const r = await h.execute(call('torrents.stop', { hashes: HASH.debian }), {
      onApproval: (a) => {
        shown.push(a.message);
        a.approve();
      },
    });
    h.setOperationLevel('torrents.stop', null);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(shown[0]).toContain('qBittorrent torrents.stop on torrent "Debian 12 Netinst"');
    expect(fake.torrents.get(HASH.debian)?.state).toBe('stoppedUP');
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$name → "$confirm"', async ({ key, call: c, confirm, shows, effect }) => {
      h.setOperationLevel(key, 'ask');
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(c.key, c.params), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message, JSON.stringify(a.pending));
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      expect(h.audit({ operationKey: key }).at(-1)?.operationKey).toBe(key);
      expect(shown[0]).toContain(shows);
      const text = shown.join('\n');
      const audit = JSON.stringify(h.audit({ operationKey: key }));
      for (const secret of SECRET_VALUES) {
        expect(text).not.toContain(secret);
        expect(audit).not.toContain(secret);
      }
      effect(fake);
    });

    it('refuses a locked call when the approver is not there to type', async () => {
      h.setOperationLevel('torrents.delete', 'ask');
      await expect(
        h.execute(call('torrents.delete', { hashes: HASH.ubuntu, deleteFiles: false })),
      ).resolves.toMatchObject({ ok: false });
      h.setOperationLevel('torrents.delete', null);
      expect(fake.torrents.has(HASH.ubuntu)).toBe(true);
    });

    it('refuses a delete of a torrent qBittorrent does not have: no literal', async () => {
      h.setOperationLevel('torrents.delete', 'ask');
      const r = await h.execute(call('torrents.delete', { hashes: 'ee'.repeat(20), deleteFiles: false }), {
        onApproval: (a) => a.approve(HOST),
      });
      h.setOperationLevel('torrents.delete', null);
      expect(r).toMatchObject({ ok: false });
      expect(fake.calls.filter((x) => x.path === 'torrents/delete')).toEqual([]);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      [
        'app.preferences',
        undefined,
        [
          SECRETS.apiKey,
          SECRETS.proxyPassword,
          SECRETS.mailPassword,
          SECRETS.dyndnsPassword,
          SECRETS.autorunKey,
          SECRETS.listKey,
          SECRETS.extraPasskey,
        ],
      ],
      ['torrents.info', undefined, [SECRETS.passkey, SECRETS.privatePasskey]],
      ['sync.maindata', undefined, [SECRETS.passkey, SECRETS.privatePasskey]],
      ['torrents.webseeds', { hash: HASH.ubuntu }, [SECRETS.webSeedKey]],
      ['rss.items', { withData: true }, [SECRETS.feedKey]],
      ['rss.rules', undefined, [SECRETS.feedKey, SECRETS.sslKey]],
      ['search.results', { id: 7 }, [SECRETS.searchKey]],
      ['log.main', undefined, [SECRETS.privatePasskey]],
    ] as const)('%s', async (key, params, secrets) => {
      allow(key, 'read');
      const r = await h.execute(call(key, params));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain(SECRETS.passkey);
    });

    it('adds a masked search result, sending the real URL to qBittorrent only', async () => {
      allow('search.results', 'read');
      h.setOperationLevel('torrents.add', 'ask');
      const shown: string[] = [];
      const r = await h.execute(
        `const res = await qbittorrent.call('search.results', { id: 7 });
         return await qbittorrent.call('torrents.add', { urls: res.results[0].fileUrl, savepath: '/downloads/iso' });`,
        { onApproval: (a) => (shown.push(a.message), a.approve(HOST)) },
      );
      h.setOperationLevel('torrents.add', null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(shown[0]).toContain(
        'into "/downloads/iso" on qBittorrent at 127.0.0.1: 1 source(s): https://search.example',
      );
      expect(fake.calls.at(-1)?.fields.urls).toContain(SECRETS.searchKey);
      expect(JSON.stringify(h.audit({ operationKey: 'torrents.add' }))).not.toContain(SECRETS.searchKey);
    });
  });

  it('refuses excluded endpoints as unknown operations', async () => {
    for (const key of [
      'auth.login',
      'app.setCookies',
      'app.cookies',
      'torrents.export',
      'app.getDirectoryContent',
      'app.rotateAPIKey',
    ])
      await expect(h.execute(call(key)), key).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNKNOWN_OPERATION' },
      });
  });

  it('reports rejected credentials and an unreachable server cleanly', async () => {
    await expect(h.testConnection({ baseUrl: fake.url, username: 'admin', password: 'wrong' })).resolves.toMatchObject({
      ok: false,
      message: 'qBittorrent rejected the username or password',
    });
    await expect(
      h.testConnection({ baseUrl: 'http://127.0.0.1:1', username: 'a', password: 'b' }),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'torrents.tags', code: call('torrents.tags') },
        write: { key: 'torrents.createTags', code: call('torrents.createTags', { tags: 'contract' }) },
        locked: { key: 'app.shutdown', code: call('app.shutdown'), confirm: HOST },
        secrets: { code: call('app.preferences'), values: [SECRETS.apiKey, SECRETS.proxyPassword] },
      }),
    ).toEqual([]);
  });
});
