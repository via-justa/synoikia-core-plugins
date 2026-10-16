import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, custom, settings, splitWhen } from '../src/catalog.js';
import { lockedKeys } from '../src/locks.js';
import { tagFor } from '../src/spec.js';
import { SPEC_TEXT } from './fake-prowlarr.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned Prowlarr v2.6.5.5623 spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

describe('Prowlarr catalog (pinned spec)', () => {
  it('keys every operation by the spec path, /api/v1 included', () => {
    expect(catalog.operations).toHaveLength(118);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|DELETE) \/api\/v1\//);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(24);
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
    expect(locked).toHaveLength(45);
  });

  it('has a lock case for every named lock and every twin', () => {
    const cases = new Set(LOCK_CASES.map((c) => c.key));
    for (const o of catalog.operations.filter((x) => x.locked && !x.key.startsWith('DELETE ')))
      expect(cases, o.key).toContain(o.key);
    for (const o of catalog.operations.filter((x) => x.key.includes('#'))) expect(cases, o.key).toContain(o.key);
    for (const key of cases) expect(op(key)?.locked, key).toBe(true);
  });

  it('locks application changes, tests and actions, indexer and proxy writes, and the bulk editors', () => {
    for (const key of [
      'POST /api/v1/applications',
      'PUT /api/v1/applications/{id}',
      'PUT /api/v1/applications/bulk',
      'POST /api/v1/applications/test',
      'POST /api/v1/applications/testall',
      'PUT /api/v1/config/development/{id}',
      'POST /api/v1/applications/test#stored',
      'POST /api/v1/applications/action/{name}',
      'POST /api/v1/applications/action/{name}#stored',
      'DELETE /api/v1/applications/{id}',
      'POST /api/v1/indexer',
      'PUT /api/v1/indexer/{id}',
      'PUT /api/v1/indexer/bulk',
      'DELETE /api/v1/indexer/bulk',
      'POST /api/v1/indexerproxy',
      'PUT /api/v1/indexerproxy/{id}',
    ])
      expect(op(key), key).toMatchObject({ locked: true, typedConfirmation: true });
    for (const key of ['GET /api/v1/search', 'GET /api/v1/history', 'GET /api/v1/indexerstats', 'GET /api/v1/indexer'])
      expect(op(key), key).toMatchObject({ locked: false, classification: 'read' });
    for (const key of ['POST /api/v1/search', 'POST /api/v1/search/bulk', 'POST /api/v1/indexer/testall'])
      expect(op(key), key).toMatchObject({ locked: false, classification: 'write' });
  });

  it('matches at least one operation with every rule pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out the UI, sign-in, log files, filesystem browsing, the backup upload and the Newznab proxy', () => {
    for (const key of [
      'GET /',
      'GET /{path}',
      'POST /login',
      'GET /ping',
      'GET /api',
      'GET /api/v1/log/file',
      'GET /api/v1/log/file/{filename}',
      'GET /api/v1/log/file/update/{filename}',
      'GET /api/v1/filesystem',
      'GET /api/v1/filesystem/type',
      'POST /api/v1/system/backup/restore/upload',
      'GET /{id}/api',
      'GET /{id}/download',
      'GET /api/v1/indexer/{id}/newznab',
      'GET /api/v1/indexer/{id}/download',
    ])
      expect(keys.has(key), key).toBe(false);
    const specKeys = Object.entries(specOf().paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((verb) => VERBS.includes(verb))
        .map((verb) => `${verb.toUpperCase()} ${path}`),
    );
    const twins = catalog.operations.filter((o) => o.key.includes('#')).length;
    expect(specKeys.length - (keys.size - twins)).toBe(19);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      expect(o.classification, o.key).toBe(o.key.startsWith('GET ') && !o.locked ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('hides provider fields in params, host secrets and search and history links in results', () => {
    for (const key of [
      'POST /api/v1/downloadclient',
      'PUT /api/v1/indexer/{id}',
      'POST /api/v1/indexerproxy',
      'POST /api/v1/notification/test',
      'POST /api/v1/applications',
      'POST /api/v1/applications/test#stored',
    ])
      expect(op(key)?.sensitiveParams, key).toContain('/body/fields');
    expect(op('PUT /api/v1/config/host/{id}')?.sensitiveParams).toEqual(
      expect.arrayContaining(['/body/apiKey', '/body/password', '/body/proxyPassword']),
    );
    expect(op('GET /api/v1/config/host')?.sensitiveResult).toMatchObject({ keys: expect.arrayContaining(['apiKey']) });
    for (const key of [
      'GET /api/v1/search',
      'POST /api/v1/search',
      'GET /api/v1/history',
      'GET /api/v1/history/indexer',
    ])
      expect(op(key)?.sensitiveResult, key).toEqual({ keys: ['downloadUrl', 'magnetUrl', 'url'], deep: true });
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/api/v1/history/{id}': { delete: { tags: ['History'] } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /api/v1/history/{id}')).toMatchObject({
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
    const { post: _gone, ...rest } = spec.paths['/api/v1/applications']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/api/v1/applications': rest } };
    expect(() => buildCatalog(renamed)).toThrow(/lacks locked operations \(POST \/api\/v1\/applications\)/);
  });
});

describe('split predicates and literals', () => {
  const call = (key: string, params: object) =>
    ({ key, method: key.split(' ')[0], template: key.split(' ')[1], params, request: {} }) as Parameters<
      (typeof splitWhen)['heavy']
    >[0];

  it('takes #heavy for any command not listed as quick, compared case-insensitively', () => {
    const heavy = (body: unknown) => splitWhen.heavy!(call('POST /api/v1/command', { body }));
    expect(heavy({ name: 'CheckHealth' })).toBe(false);
    expect(heavy({ name: 'indexerdefinitionupdate' })).toBe(false);
    for (const name of [
      'ApplicationIndexerSync',
      'ApplicationUpdateCheck',
      'ApplicationUpdate',
      'ClearHistory',
      'ClearLog',
      'DeleteLogFiles',
      'ResetApiKey',
      'Restart',
      'Nope',
      7,
    ])
      expect(heavy({ name }), String(name)).toBe(true);
    expect(heavy(undefined)).toBe(true);
  });

  it('takes #stored when the body names a stored provider', () => {
    const stored = (body: unknown) => splitWhen.stored!(call('POST /api/v1/applications/test', { body }));
    expect([stored({}), stored({ id: 0 }), stored({ id: null })]).toEqual([false, false, false]);
    expect([stored({ id: 4 }), stored({ id: '4' })]).toEqual([true, true]);
  });

  it('counts the providers a bulk call changes', () => {
    const count = (key: string, body: unknown) => custom.count!({ key, params: { body }, targets: [] });
    expect(count('PUT /api/v1/indexer/bulk', { ids: [1, 2, 3] })).toBe('3 indexers');
    expect(count('DELETE /api/v1/applications/bulk', { ids: [4] })).toBe('1 application');
    expect(count('DELETE /api/v1/downloadclient/bulk', { ids: [6, 7] })).toBe('2 download clients');
    expect(count('DELETE /api/v1/indexer/bulk', {})).toBeUndefined();
  });
});

describe('spec tag', () => {
  it('maps a 4-part Servarr version to its tag and nothing else', () => {
    expect(tagFor('2.6.5.5623')).toBe('v2.6.5.5623');
    expect(tagFor('v2.6.5.5623')).toBe('v2.6.5.5623');
    for (const v of ['2.6.5', '2.6.5.5623-nightly', 'develop', '../x']) expect(tagFor(v), v).toBeUndefined();
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
