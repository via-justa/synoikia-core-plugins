import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, INSTANCE, SECRETS, SPEC_REF, SPEC_SHA256, startFakePlex, VERSION } from './fake-plex.js';
import type { FakePlex } from './fake-plex.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Plex, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_SHA256 = 'ff8801eb6c7904e6298215dd789521750e4af0f18b5fde0999bb544d15335070';

/** A copy of the built plugin that expects the reduced fixture's digest; the real bundle stays untouched. */
function stageTestCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'plex-e2e-'));
  for (const name of ['manifest.json', 'package.json', 'instructions.md', 'dist'])
    cpSync(path.join(PLUGIN_DIR, name), path.join(dir, name), { recursive: true });
  const entry = path.join(dir, 'dist', 'index.js');
  const bundle = readFileSync(entry, 'utf8');
  if (bundle.split(PINNED_SHA256).length !== 2) throw new Error('the bundle must pin the spec digest exactly once');
  writeFileSync(entry, bundle.replace(PINNED_SHA256, SPEC_SHA256));
  return dir;
}

let stagedDir: string | undefined;

let h: PluginHarness;
let fake: FakePlex;

beforeAll(async () => {
  fake = await startFakePlex();
  stagedDir = stageTestCopy();
  h = await startPluginHarness({
    pluginDir: stagedDir,
    connection: { baseUrl: fake.url, specBaseUrl: fake.specUrl, ...CREDENTIALS },
  });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
  if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
});

beforeEach(() => fake.reset());

const call = (request: unknown) => `return await plex.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);
const SECRET_VALUES = Object.values(SECRETS);
const URL_SECRETS = ['trailer-signature-888888', 'provider-key-999999', 'subtitle-key-131313', 'tuner-key-141414'];

describe('Plex end to end (fake Plex)', () => {
  it('syncs the PMS operations of the pinned spec', () => {
    expect(h.operations()).toHaveLength(306);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(fake.specFetches.map((f) => f.ref)).toContain(SPEC_REF);
    expect(h.operation('PUT /:/prefs')).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it('lists libraries, recently added and searches at Read', async () => {
    allow('GET /library/sections/all', 'read');
    allow('GET /library/sections/{sectionId}/recentlyAdded', 'read');
    allow('GET /hubs/search', 'read');
    const r = await h.execute(
      `const libs = await plex.request({ path: '/library/sections/all' });
       const movies = libs.MediaContainer.Directory.find((d) => d.type === 'movie');
       const recent = await plex.request({ path: '/library/sections/' + movies.key + '/recentlyAdded', query: { 'X-Plex-Container-Size': 5 } });
       const hits = await plex.request({ path: '/hubs/search', query: { query: 'incep' } });
       return recent.MediaContainer.Metadata.length + ' ' + hits.MediaContainer.Hub[0].Metadata[0].title;`,
    );
    expect(r).toMatchObject({ ok: true, value: '3 Inception' });
  });

  it('marks an item watched once a human approves it at Ask', async () => {
    h.setOperationLevel('PUT /:/scrobble', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      call({ method: 'PUT', path: '/:/scrobble', query: { key: 101, identifier: 'com.plexapp.plugins.library' } }),
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    h.setOperationLevel('PUT /:/scrobble', null);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(shown[0]).toContain('Plex PUT /:/scrobble');
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$name → "$confirm"', async ({ key, request, confirm }) => {
      h.setOperationLevel(key, 'ask');
      await expect(h.execute(call(request))).resolves.toMatchObject({ ok: false });
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(request), {
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
      const text = shown.join('\n');
      const audit = JSON.stringify(h.audit({ operationKey: key }));
      for (const secret of [...URL_SECRETS, ...SECRET_VALUES]) {
        expect(text).not.toContain(secret);
        expect(audit).not.toContain(secret);
      }
      // The approver sees where Plex fetches from or connects to.
      const url = request.query?.url;
      if (typeof url === 'string' && url.startsWith('https://'))
        expect(shown[0]).toContain(`fetches ${new URL(url).origin}`);
      const uri = request.query?.uri;
      if (key === 'POST /media/grabbers/devices' && typeof uri === 'string')
        expect(shown[0]).toContain(`connects to ${new URL(uri).origin}`);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /:/prefs', { path: '/:/prefs' }, [SECRETS.onlineToken, SECRETS.certKey]],
      ['GET /status/sessions', { path: '/status/sessions' }, [SECRETS.thumbToken]],
      ['GET /media/providers', { path: '/media/providers' }, [SECRETS.providerUrlToken]],
      ['GET /myplex/account', { path: '/myplex/account' }, [SECRETS.accountToken]],
      ['GET /servers', { path: '/servers' }, [SECRETS.serverToken]],
      ['GET /devices', { path: '/devices' }, [SECRETS.deviceToken]],
    ])('%s', async (key, request, secrets) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
    });

    it('keeps a fetched URL out of the approval and the audit log', async () => {
      const key = 'POST /media/providers';
      const url = 'https://provider.example/p?key=new-provider-key-121212';
      h.setOperationLevel(key, 'ask');
      const shown: string[] = [];
      const r = await h.execute(call({ method: 'POST', path: '/media/providers', query: { url } }), {
        onApproval: (a) => {
          shown.push(a.message, JSON.stringify(a.pending));
          a.approve(INSTANCE);
        },
      });
      h.setOperationLevel(key, null);
      expect(r.ok).toBe(true);
      expect(shown[0]).toContain('fetches https://provider.example');
      expect(shown.join('\n')).not.toContain('new-provider-key-121212');
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain('new-provider-key-121212');
    });

    it('refuses to write back a masked value', async () => {
      h.setOperationLevel('PUT /:/prefs', 'ask');
      const r = await h.execute(call({ method: 'PUT', path: '/:/prefs', query: { PlexOnlineToken: '[REDACTED]' } }));
      h.setOperationLevel('PUT /:/prefs', null);
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    });
  });

  it('refuses plex.tv and excluded paths as unknown operations', async () => {
    for (const p of ['/users/account.json', '/services/browse', '/diagnostics/logs'])
      await expect(h.execute(call({ path: p })), p).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNKNOWN_OPERATION' },
      });
  });

  it('reports a Plex denial as UPSTREAM_DENIED', async () => {
    allow('GET /playlists', 'read');
    fake.denied.add('/playlists');
    await expect(h.execute(call({ path: '/playlists' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/playlists');
  });

  it('reports a rejected token and an unreachable server cleanly', async () => {
    await expect(
      h.testConnection({ baseUrl: fake.url, specBaseUrl: fake.specUrl, token: 'wrong' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', token: 'k' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /playlists', code: call({ path: '/playlists' }) },
        write: {
          key: 'PUT /:/unscrobble',
          code: call({
            method: 'PUT',
            path: '/:/unscrobble',
            query: { key: 101, identifier: 'com.plexapp.plugins.library' },
          }),
        },
        locked: { key: 'PUT /updater/apply', code: call({ method: 'PUT', path: '/updater/apply' }), confirm: INSTANCE },
        secrets: { code: call({ path: '/myplex/account' }), values: [SECRETS.accountToken] },
      }),
    ).toEqual([]);
  });
});
