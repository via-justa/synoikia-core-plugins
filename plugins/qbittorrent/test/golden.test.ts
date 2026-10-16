import { maskSensitiveResult, REDACTED } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQbittorrentPlugin } from '../src/plugin.js';
import { CREDENTIALS, HASH, startFakeQbittorrent } from './fake-qbittorrent.js';
import type { FakeQbittorrent } from './fake-qbittorrent.js';
import { LOCK_CASES } from './locks.js';

/** Golden record of what the plugin tells core (descriptors, locked summaries, literals and targets, masked results):
 * review snapshot diffs as security changes. */

/** Stable JSON (sorted keys): property order means nothing to core. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2);
}

/** Core summarizes params with the declared `sensitiveParams` hidden; do the same here. */
function redactPaths(params: unknown, pointers: readonly string[]): unknown {
  const copy: unknown = structuredClone(params);
  for (const pointer of pointers) {
    const parts = pointer.split('/').slice(1);
    const last = parts.pop();
    let node: unknown = copy;
    for (const p of parts) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[p] : undefined;
    if (last && node && typeof node === 'object' && last in node) (node as Record<string, unknown>)[last] = REDACTED;
  }
  return copy;
}

// A fixed key, so masked URLs are stable across runs (test only; the plugin draws a random one).
const plugin = createQbittorrentPlugin({ maskKey: new Uint8Array(32).fill(1) });
let fake: FakeQbittorrent;
let operations: OperationDescriptor[];
const context = { callId: 'golden', deadlineMs: 5000 };

beforeAll(async () => {
  fake = await startFakeQbittorrent();
  await plugin.init({
    instanceId: 'qbittorrent',
    config: { baseUrl: fake.url, username: CREDENTIALS.username },
    secrets: { password: CREDENTIALS.password },
    sdkVersion: '1.0.0',
  });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

/** The fake's port changes per run; the golden files name it as 127.0.0.1:PORT. */
const portless = (text: string) => text.replaceAll(new URL(fake.url).host, '127.0.0.1:PORT');

describe('qBittorrent golden record', () => {
  it('catalog: every descriptor', async () => {
    await expect(stable(operations)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries, targets and confirm literals of locked operations', async () => {
    const out: Record<string, unknown> = {};
    for (const c of LOCK_CASES) {
      fake.reset();
      const { key, params } = await plugin.resolveOperation({ fn: 'call', args: [c.call.key, c.call.params] });
      const declared = operations.find((o) => o.key === key)?.sensitiveParams ?? [];
      const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
      const shown = redactPaths(params, declared);
      out[c.name] = { resolved: key, targets, ...(await plugin.summarize({ key, params: shown, targets })) };
    }
    await expect(portless(stable(out))).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('summaries of writes that move data without a lock', async () => {
    const urls = `magnet:?xt=urn:btih:${'dd'.repeat(20)}&dn=Fedora`;
    const cases: [string, string, Record<string, unknown>][] = [
      ['setCategory (explicit path)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: 'movies' }],
      ['setCategory (implicit path)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: 'tv' }],
      ['setCategory (subcategory)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: 'tv/shows' }],
      ['setCategory (clear)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: '' }],
      ['setCategory (unknown)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: 'nope' }],
      ['add (manual, relative savepath)', 'torrents.add', { urls, savepath: 'iso' }],
      [
        'add (autoTMM, savepath ignored)',
        'torrents.add',
        { urls, category: 'tv', savepath: '/elsewhere', autoTMM: true },
      ],
      ['add (autoTMM, no category)', 'torrents.add', { urls, autoTMM: true }],
      [
        'add (magnet keys in any case: TR, tr., WS, x.pe, dht)',
        'torrents.add',
        {
          urls: `${urls}&TR=${encodeURIComponent('http://10.0.0.1/admin')}&tr.=${encodeURIComponent('udp://open.example:1337/a')}&WS=${encodeURIComponent('https://seed.example/f')}&x.pe=10.0.0.2:6881&dht=router.example:6881`,
        },
      ],
      ['setCategory (reserved characters)', 'torrents.setCategory', { hashes: HASH.ubuntu, category: 'tv/odd:name?' }],
      [
        'setCategory (under a parent with its own path)',
        'torrents.setCategory',
        { hashes: HASH.ubuntu, category: 'films/x' },
      ],
      ['editCategory (to implicit)', 'torrents.editCategory', { category: 'movies', savePath: '' }],
      [
        'add (download path, share limit action)',
        'torrents.add',
        { urls, savepath: '/a/../b', downloadPath: '/tmp/x/../dl', shareLimitAction: 'RemoveWithContent' },
      ],
      [
        'setRule (save path cleaned, download path, share limit action)',
        'rss.setRule',
        {
          ruleName: 'New',
          ruleDef: {
            affectedFeeds: [],
            torrentParams: {
              save_path: '/downloads/../srv/./iso',
              download_path: '/tmp/dl',
              share_limit_action: 'Stop',
            },
          },
        },
      ],
      [
        'setRule (automatic management, category)',
        'rss.setRule',
        { ruleName: 'New', ruleDef: { torrentParams: { category: 'tv', use_auto_tmm: true } } },
      ],
    ];
    const out: Record<string, unknown> = {};
    for (const [name, key, raw] of cases) {
      fake.reset();
      const { key: resolved, params } = await plugin.resolveOperation({ fn: 'call', args: [key, raw] });
      const targets = (await plugin.resolveTargets?.({ key: resolved, params })) ?? [];
      out[name] = { resolved, ...(await plugin.summarize({ key: resolved, params, targets })) };
    }
    await expect(portless(stable(out))).toMatchFileSnapshot('__golden__/writes.json');
  });

  it('results with URLs and secrets, as core passes them on', async () => {
    fake.reset();
    const calls: [string, unknown][] = [
      ['app.preferences', undefined],
      ['torrents.info', { hashes: HASH.ubuntu }],
      ['torrents.trackers', { hash: HASH.ubuntu }],
      ['torrents.webseeds', { hash: HASH.ubuntu }],
      ['rss.items', { withData: true }],
      ['rss.rules', undefined],
      ['search.results', { id: 7 }],
      ['log.main', undefined],
    ];
    const out: Record<string, unknown> = {};
    for (const [key, params] of calls) {
      const resolved = await plugin.resolveOperation({ fn: 'call', args: [key, params] });
      const descriptor = operations.find((o) => o.key === resolved.key);
      const result = await plugin.invoke({ key: resolved.key, params: resolved.params, context });
      out[key] = {
        sensitiveResult: descriptor?.sensitiveResult ?? null,
        result: maskSensitiveResult(result, descriptor?.sensitiveResult),
      };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/masked.json');
  });
});
