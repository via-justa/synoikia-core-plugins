import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, settings, splitWhen } from '../src/catalog.js';
import { lockedKeys } from '../src/locks.js';
import { tagFor } from '../src/spec.js';
import { SPEC_TEXT } from './fake-lidarr.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned Lidarr v3.1.6.5078 spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

describe('Lidarr catalog (pinned spec)', () => {
  it('keys every operation by the spec path, /api/v1 included', () => {
    expect(catalog.operations).toHaveLength(225);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|DELETE) \/api\/v1\//);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(27);
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
    expect(locked).toHaveLength(63);
  });

  it('has a lock case for every named lock and every twin', () => {
    const cases = new Set(LOCK_CASES.map((c) => c.key));
    for (const o of catalog.operations.filter((x) => x.locked && !x.key.startsWith('DELETE ')))
      expect(cases, o.key).toContain(o.key);
    for (const o of catalog.operations.filter((x) => x.key.includes('#'))) expect(cases, o.key).toContain(o.key);
    for (const key of cases) expect(op(key)?.locked, key).toBe(true);
  });

  it('matches at least one operation with every rule pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
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
      'GET /feed/v1/calendar/lidarr.ics',
      'GET /api/v1/log/file/{filename}',
      'GET /api/v1/mediacover/artist/{artistId}/{filename}',
      'GET /api/v1/mediacover/album/{albumId}/{filename}',
      'GET /api/v1/log/file/update/{filename}',
      'GET /api/v1/filesystem',
      'GET /api/v1/filesystem/mediafiles',
      'GET /api/v1/manualimport',
      'POST /api/v1/manualimport',
      'POST /api/v1/system/backup/restore/upload',
    ])
      expect(keys.has(key), key).toBe(false);
    const specKeys = Object.entries(specOf().paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((verb) => VERBS.includes(verb))
        .map((verb) => `${verb.toUpperCase()} ${path}`),
    );
    const twins = catalog.operations.filter((o) => o.key.includes('#')).length;
    expect(specKeys.length - (keys.size - twins)).toBe(21);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      expect(o.classification, o.key).toBe(o.key.startsWith('GET ') && !o.locked ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('hides provider fields in params, host secrets and release URLs in results', () => {
    for (const key of [
      'POST /api/v1/downloadclient',
      'PUT /api/v1/indexer/{id}',
      'POST /api/v1/notification/test',
      'POST /api/v1/importlist/test#stored',
    ])
      expect(op(key)?.sensitiveParams, key).toContain('/body/fields');
    expect(op('PUT /api/v1/config/host/{id}')?.sensitiveParams).toEqual(
      expect.arrayContaining(['/body/apiKey', '/body/password', '/body/proxyPassword']),
    );
    expect(op('GET /api/v1/config/host')?.sensitiveResult).toMatchObject({ keys: expect.arrayContaining(['apiKey']) });
    expect(op('GET /api/v1/release')?.sensitiveResult).toEqual({
      keys: ['downloadUrl', 'magnetUrl', 'url'],
      deep: true,
    });
    expect(op('GET /api/v1/history')?.sensitiveResult).toEqual({
      keys: ['downloadUrl', 'magnetUrl', 'url'],
      deep: true,
    });
    expect(op('POST /api/v1/release/push')?.sensitiveParams).toEqual([
      '/body/downloadUrl',
      '/body/magnetUrl',
      '/body/guid',
      '/body/infoUrl',
      '/body/commentUrl',
    ]);
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/api/v1/series/{id}': { delete: { tags: ['Series'] } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /api/v1/series/{id}')).toMatchObject({
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
    const { post: _gone, ...rest } = spec.paths['/api/v1/system/restart']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/api/v1/system/restart': rest } };
    expect(() => buildCatalog(renamed)).toThrow(/lacks locked operations \(POST \/api\/v1\/system\/restart\)/);
  });
});

describe('split predicates', () => {
  const call = (key: string, params: object) =>
    ({ key, method: key.split(' ')[0], template: key.split(' ')[1], params, request: {} }) as Parameters<
      (typeof splitWhen)['heavy']
    >[0];

  it('takes #delete-files and #move-files for any flag that is not plainly off', () => {
    const del = (query?: object) => splitWhen['delete-files']!(call('DELETE /api/v1/artist/{id}', { query }));
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
    const album = (query?: object) => splitWhen['delete-files']!(call('DELETE /api/v1/album/{id}', { query }));
    expect([album(undefined), album({ deleteFiles: true })]).toEqual([false, true]);
    const bulk = (body?: unknown) => splitWhen['delete-files']!(call('DELETE /api/v1/artist/editor', { body }));
    expect([bulk({ artistIds: [1] }), bulk({ artistIds: [1], deleteFiles: true }), bulk(undefined)]).toEqual([
      false,
      true,
      true,
    ]);
    expect(splitWhen['move-files']!(call('PUT /api/v1/artist/{id}', { query: { moveFiles: 'True' } }))).toBe(true);
  });

  it('takes #heavy for any command not listed as quick, compared case-insensitively', () => {
    const heavy = (body: unknown) => splitWhen.heavy!(call('POST /api/v1/command', { body }));
    expect(heavy({ name: 'AlbumSearch', albumIds: [1] })).toBe(false);
    expect(heavy({ name: 'rsssync' })).toBe(false);
    for (const name of [
      'RefreshArtist',
      'refreshalbum',
      'BulkRefreshArtist',
      'RenameFiles',
      'RenameArtist',
      'RetagFiles',
      'RetagArtist',
      'RescanFolders',
      'ManualImport',
      'DownloadedAlbumsScan',
      'MoveArtist',
      'BulkMoveArtist',
      'InstallPlugin',
      'DeleteLogFiles',
      'ResetApiKey',
      'ApplicationUpdate',
      'ApplicationUpdateCheck',
      'Nope',
      7,
    ])
      expect(heavy({ name }), String(name)).toBe(true);
    expect(heavy(undefined)).toBe(true);
  });

  it('takes #stored when the body names a stored provider', () => {
    const stored = (body: unknown) => splitWhen.stored!(call('POST /api/v1/downloadclient/test', { body }));
    expect([stored({}), stored({ id: 0 }), stored({ id: null })]).toEqual([false, false, false]);
    expect([stored({ id: 6 }), stored({ id: '6' })]).toEqual([true, true]);
  });
});

describe('spec tag', () => {
  it('maps a 4-part Servarr version to its tag and nothing else', () => {
    expect(tagFor('3.1.6.5078')).toBe('v3.1.6.5078');
    expect(tagFor('v3.1.6.5078')).toBe('v3.1.6.5078');
    for (const v of ['3.1.6', '3.1.6.5078-nightly', 'develop', '../x']) expect(tagFor(v), v).toBeUndefined();
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
