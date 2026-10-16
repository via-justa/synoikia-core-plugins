import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, settings, splitWhen } from '../src/catalog.js';
import { lockedKeys } from '../src/locks.js';
import { tagFor } from '../src/spec.js';
import { SPEC_TEXT } from './fake-radarr.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned Radarr v6.4.4.10685 spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

describe('Radarr catalog (pinned spec)', () => {
  it('keys every operation by the spec path, /api/v3 included', () => {
    expect(catalog.operations).toHaveLength(227);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|DELETE) \/api\/v3\//);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(22);
    for (const key of locked) {
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks every delete, every split twin and nothing the rules do not name', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    for (const o of catalog.operations.filter((x) => x.key.startsWith('DELETE ') || x.key.includes('#')))
      expect(o.locked, o.key).toBe(true);
    const named = new Set(lockedKeys(settings.rules));
    const extra = locked.filter((k) => !k.startsWith('DELETE ') && !k.includes('#') && !named.has(k));
    expect(extra).toEqual([]);
    expect(locked).toHaveLength(59);
  });

  it('has a lock case for every named lock and every twin', () => {
    const cases = new Set(LOCK_CASES.map((c) => c.key));
    for (const o of catalog.operations.filter((x) => x.locked && !x.key.startsWith('DELETE ')))
      expect(cases, o.key).toContain(o.key);
    for (const o of catalog.operations.filter((x) => x.key.includes('#'))) expect(cases, o.key).toContain(o.key);
    for (const key of cases) expect(op(key)?.locked, key).toBe(true);
  });

  it('matches at least one operation with every rule pattern', () => {
    // Forward-looking: the pinned spec has no root folder PUT, a newer one may add it.
    const ahead = new Set(['PUT /api/v3/rootfolder/*']);
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)).filter((p) => !ahead.has(p)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out the UI, sign-in, feeds, file downloads, filesystem browsing and the backup upload', () => {
    for (const key of [
      'GET /',
      'GET /{path}',
      'POST /login',
      'GET /ping',
      'GET /api',
      'GET /feed/v3/calendar/radarr.ics',
      'GET /api/v3/log/file/{filename}',
      'GET /api/v3/mediacover/{movieId}/{filename}',
      'GET /api/v3/filesystem',
      'GET /api/v3/filesystem/mediafiles',
      'GET /api/v3/manualimport',
      'POST /api/v3/manualimport',
      'POST /api/v3/system/backup/restore/upload',
    ])
      expect(keys.has(key), key).toBe(false);
    const specKeys = Object.entries(specOf().paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((verb) => VERBS.includes(verb))
        .map((verb) => `${verb.toUpperCase()} ${path}`),
    );
    const twins = catalog.operations.filter((o) => o.key.includes('#')).length;
    expect(specKeys.length - (keys.size - twins)).toBe(20);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      expect(o.classification, o.key).toBe(o.key.startsWith('GET ') && !o.locked ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('hides provider fields in params, host secrets and release URLs in results', () => {
    for (const key of [
      'POST /api/v3/downloadclient',
      'PUT /api/v3/indexer/{id}',
      'POST /api/v3/notification/test',
      'POST /api/v3/importlist/test#stored',
    ])
      expect(op(key)?.sensitiveParams, key).toContain('/body/fields');
    expect(op('PUT /api/v3/config/host/{id}')?.sensitiveParams).toEqual(
      expect.arrayContaining(['/body/apiKey', '/body/password', '/body/proxyPassword']),
    );
    expect(op('GET /api/v3/config/host')?.sensitiveResult).toMatchObject({ keys: expect.arrayContaining(['apiKey']) });
    expect(op('GET /api/v3/release')?.sensitiveResult).toEqual({
      keys: ['downloadUrl', 'magnetUrl', 'url'],
      deep: true,
    });
    expect(op('GET /api/v3/history')?.sensitiveResult).toEqual({
      keys: ['downloadUrl', 'magnetUrl', 'url'],
      deep: true,
    });
    expect(op('POST /api/v3/release/push')?.sensitiveParams).toEqual([
      '/body/downloadUrl',
      '/body/magnetUrl',
      '/body/guid',
      '/body/infoUrl',
      '/body/commentUrl',
    ]);
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/api/v3/series/{id}': { delete: { tags: ['Series'] } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /api/v3/series/{id}')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('locks a root folder PUT a newer spec adds, confirmed on the new path', () => {
    const spec = specOf();
    const item = { ...spec.paths['/api/v3/rootfolder/{id}'], put: { tags: ['RootFolder'] } };
    const newer = { ...spec, paths: { ...spec.paths, '/api/v3/rootfolder/{id}': item } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'PUT /api/v3/rootfolder/{id}')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('refuses a truncated spec', () => {
    const spec = specOf();
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 20)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });

  it('refuses a spec that lost a locked operation, as after an upstream rename', () => {
    const spec = specOf();
    const { post: _gone, ...rest } = spec.paths['/api/v3/system/restart']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/api/v3/system/restart': rest } };
    expect(() => buildCatalog(renamed)).toThrow(/lacks locked operations \(POST \/api\/v3\/system\/restart\)/);
  });
});

describe('split predicates', () => {
  const call = (key: string, params: object) =>
    ({ key, method: key.split(' ')[0], template: key.split(' ')[1], params, request: {} }) as Parameters<
      (typeof splitWhen)['heavy']
    >[0];

  it('takes #delete-files and #move-files for any flag that is not plainly off', () => {
    const del = (query?: object) => splitWhen['delete-files']!(call('DELETE /api/v3/movie/{id}', { query }));
    expect([undefined, { deleteFiles: false }, { deleteFiles: 'false' }].map((q) => del(q))).toEqual([
      false,
      false,
      false,
    ]);
    expect([{ deleteFiles: true }, { deleteFiles: 'true' }, { deleteFiles: 1 }].map((q) => del(q))).toEqual([
      true,
      true,
      true,
    ]);
    const bulk = (body?: unknown) => splitWhen['delete-files']!(call('DELETE /api/v3/movie/editor', { body }));
    expect([bulk({ movieIds: [1] }), bulk({ movieIds: [1], deleteFiles: true }), bulk(undefined)]).toEqual([
      false,
      true,
      true,
    ]);
    expect(splitWhen['move-files']!(call('PUT /api/v3/movie/{id}', { query: { moveFiles: 'True' } }))).toBe(true);
  });

  it('takes #heavy for any command not listed as quick, compared case-insensitively', () => {
    const heavy = (body: unknown) => splitWhen.heavy!(call('POST /api/v3/command', { body }));
    expect(heavy({ name: 'MoviesSearch', movieIds: [1] })).toBe(false);
    expect(heavy({ name: 'rsssync' })).toBe(false);
    for (const name of [
      'RenameFiles',
      'RenameMovie',
      'DeleteLogFiles',
      'ResetApiKey',
      'ApplicationUpdate',
      'ApplicationCheckUpdate',
      'applicationcheckupdate',
      'Nope',
      7,
    ])
      expect(heavy({ name }), String(name)).toBe(true);
    expect(heavy(undefined)).toBe(true);
  });

  it('takes #stored when the body names a stored provider', () => {
    const stored = (body: unknown) => splitWhen.stored!(call('POST /api/v3/downloadclient/test', { body }));
    expect([stored({}), stored({ id: 0 }), stored({ id: null })]).toEqual([false, false, false]);
    expect([stored({ id: 6 }), stored({ id: '6' })]).toEqual([true, true]);
  });
});

describe('spec tag', () => {
  it('maps a 4-part Servarr version to its tag and nothing else', () => {
    expect(tagFor('6.4.4.10685')).toBe('v6.4.4.10685');
    expect(tagFor('v6.4.4.10685')).toBe('v6.4.4.10685');
    for (const v of ['6.4.4', '6.4.4.10685-nightly', 'develop', '../x']) expect(tagFor(v), v).toBeUndefined();
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`\s]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
