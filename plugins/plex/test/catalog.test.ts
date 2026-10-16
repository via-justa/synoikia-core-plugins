import { readFileSync } from 'node:fs';
import { parseOpenApi } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { buildCatalog, settings, splitWhen } from '../src/catalog.js';
import { lockedKeys, requiredKeys } from '../src/locks.js';
import { parseSpecSource, pmsOnly } from '../src/spec.js';
import { SPEC_TEXT } from './fake-plex.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned community spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
type Spec = { paths: Record<string, Record<string, unknown>> };
let parsed: Spec | undefined;
// Parsed once per file; tests copy it before changing it.
const specOf = () => (parsed ??= parseOpenApi(SPEC_TEXT) as Spec);
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every operation key in the spec, with whether it declares its own servers (plex.tv and cloud providers). */
function specKeys(spec: Spec) {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((verb) => VERBS.includes(verb))
      .map((verb) => ({
        key: `${verb.toUpperCase()} ${path}`,
        cloud: item.servers !== undefined || (item[verb] as { servers?: unknown }).servers !== undefined,
      })),
  );
}

describe('Plex catalog (pinned spec)', () => {
  it('keeps only the PMS operations, keyed by the spec path', () => {
    const all = specKeys(specOf());
    expect(all).toHaveLength(405);
    const cloud = all.filter((k) => k.cloud).map((k) => k.key);
    expect(cloud).toHaveLength(52);
    for (const key of cloud) expect(keys.has(key), key).toBe(false);
    for (const key of ['GET /users/account.json', 'POST /shared_servers', 'GET /friends', 'POST /pins'])
      expect(cloud).toContain(key);
    const twins = catalog.operations.filter((o) => o.key.includes('#')).length;
    expect(twins).toBe(3);
    expect(catalog.operations).toHaveLength(306);
    expect(all.length - cloud.length - (keys.size - twins)).toBe(50);
  });

  it('keeps the actions under the `:` segment, and matches them by path', () => {
    for (const key of ['PUT /:/scrobble', 'PUT /:/unscrobble', 'PUT /:/rate', 'POST /:/timeline', 'GET /:/prefs'])
      expect(keys, key).toContain(key);
    const put = catalog.byVerb.get('PUT')!.find((o) => o.key === 'PUT /:/scrobble');
    expect(put).toMatchObject({ template: '/:/scrobble', segments: [':', 'scrobble'] });
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(42);
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
    expect(locked).toHaveLength(71);
  });

  it('has a lock case for every named lock and every twin', () => {
    const cases = new Set(LOCK_CASES.map((c) => c.key));
    for (const o of catalog.operations.filter((x) => x.locked && !x.key.startsWith('DELETE ')))
      expect(cases, o.key).toContain(o.key);
    for (const key of cases) expect(op(key)?.locked, key).toBe(true);
    expect(new Set(LOCK_CASES.map((c) => c.name)).size).toBe(LOCK_CASES.length);
  });

  it('matches at least one operation with every rule and exclude pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
    const pms = specKeys(specOf())
      .filter((k) => !k.cloud)
      .map((k) => k.key);
    for (const pattern of settings.exclude)
      expect(
        pms.some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out streams, binary media, uploads, log writes, token minting, filesystem browsing and claiming', () => {
    for (const key of [
      'GET /:/websockets/notifications',
      'GET /:/eventsource/notifications',
      'GET /photo/:/transcode',
      'GET /{transcodeType}/:/transcode/universal/start.{extension}',
      'POST /downloadQueue',
      'GET /diagnostics/logs',
      'POST /log/networked',
      'PUT /log',
      'POST /security/token',
      'GET /security/resources',
      'GET /services/browse',
      'GET /services/browse/{base64path}',
      'POST /myplex/claim',
      'GET /library/parts/{partId}/{changestamp}/{filename}',
      'POST /library/metadata/{id}/posters',
      'DELETE /library/streams/{streamId}.{ext}',
    ])
      expect(keys.has(key), key).toBe(false);
  });

  it('reads with GET and writes with every other verb, apart from reviewed GETs; none left for review', () => {
    const writes = new Set([
      'GET /:/progress',
      'GET /library/sections/{sectionId}/refresh',
      'GET /library/sections/{sectionId}/match',
      'GET /media/grabbers/devices/discover',
      'GET /system/updates',
    ]);
    for (const o of catalog.operations) {
      const read = o.key.startsWith('GET ') && !o.locked && !writes.has(o.key);
      expect(o.classification, o.key).toBe(read ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('hides the URL Plex fetches or connects to from approvals, on every operation', () => {
    for (const o of catalog.operations) expect(o.sensitiveParams, o.key).toContain('/query/url');
    expect(op('POST /media/grabbers/devices')?.sensitiveParams).toEqual(['/query/url', '/query/uri']);
    expect(op('GET /library/metadata/{ids}/subtitles')).toMatchObject({ locked: true, classification: 'write' });
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/library/things/{id}': { delete: { tags: ['Library'] } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /library/things/{id}')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('drops an operation that declares its own servers, at operation or path level', () => {
    const spec = specOf();
    const prefs = spec.paths['/:/prefs']!;
    const moved = {
      ...spec,
      paths: {
        ...spec.paths,
        '/:/prefs': { ...prefs, get: { ...(prefs.get as object), servers: [{ url: 'https://plex.tv' }] } },
        '/status/sessions': { ...spec.paths['/status/sessions'], servers: [{ url: 'https://plex.tv' }] },
      },
    };
    const doc = pmsOnly(moved, 'Plex') as Spec;
    expect(Object.keys(doc.paths['/:/prefs']!)).not.toContain('get');
    expect(Object.keys(doc.paths['/:/prefs']!)).toContain('put');
    expect(doc.paths['/status/sessions']).toBeUndefined();
  });

  it('refuses a truncated spec', () => {
    const spec = specOf();
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 40)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });

  it('refuses a spec that lost an operation a rule splits or makes a write', () => {
    const required = requiredKeys(settings.rules);
    for (const key of [
      'GET /:/progress',
      'GET /system/updates',
      'GET /playQueues/{playQueueId}',
      'GET /library/metadata/{ids}',
    ])
      expect(required).toContain(key);
    const spec = specOf();
    const { get: _gone, ...rest } = spec.paths['/:/progress']!;
    expect(() => buildCatalog({ ...spec, paths: { ...spec.paths, '/:/progress': rest } })).toThrow(/GET \/:\/progress/);
    const renamed: Record<string, Record<string, unknown>> = {
      ...spec.paths,
      '/playQueue/{playQueueId}': spec.paths['/playQueues/{playQueueId}']!,
    };
    delete renamed['/playQueues/{playQueueId}'];
    expect(() => buildCatalog({ ...spec, paths: renamed })).toThrow(/GET \/playQueues\/\{playQueueId\}/);
  });

  it('refuses a spec that lost a locked operation, or moved it to plex.tv', () => {
    const spec = specOf();
    const { put: _gone, ...rest } = spec.paths['/updater/apply']!;
    expect(() => buildCatalog({ ...spec, paths: { ...spec.paths, '/updater/apply': rest } })).toThrow(
      /lacks operations its rules lock, split or make writes \(PUT \/updater\/apply\)/,
    );
    const cloud = { ...spec.paths['/:/prefs'], servers: [{ url: 'https://plex.tv' }] };
    expect(() => buildCatalog({ ...spec, paths: { ...spec.paths, '/:/prefs': cloud } })).toThrow(/PUT \/:\/prefs/);
  });

  it('refuses a spec that uses the placeholder segment', () => {
    const spec = specOf();
    expect(() => buildCatalog({ ...spec, paths: { ...spec.paths, '/-colon-/x': { get: {} } } })).toThrow(/-colon-/);
  });
});

describe('spec source', () => {
  it('takes a pinned commit, never a branch', () => {
    expect(settings.plugin.spec.ref).toMatch(/^[0-9a-f]{40}$/);
    const base = { baseUrl: 'https://x', file: 'f.yaml', maxBytes: 1, timeoutMs: 1 };
    for (const ref of ['main', 'v1.1.1', 'a632c48', '../a632c48261aedefe0bc3a9ae3ddc4bc227abcda0'])
      expect(() => parseSpecSource({ ...base, ref }), ref).toThrow(/commit SHA/);
  });
});

describe('split predicates', () => {
  const call = (query?: object) =>
    ({
      key: 'GET /library/metadata/{ids}',
      method: 'GET',
      template: '/library/metadata/{ids}',
      params: { query },
      request: {},
    }) as Parameters<(typeof splitWhen)['refresh']>[0];

  it('takes #own for own that is not plainly off', () => {
    const own = (query?: object) => splitWhen.own!(call(query));
    expect([own(undefined), own({ own: 0 }), own({ own: 'false' })]).toEqual([false, false, false]);
    expect([own({ own: 1 }), own({ own: 'true' })]).toEqual([true, true]);
  });

  it('takes #refresh for any refresh, analysis, augment or file-check flag that is not plainly off', () => {
    const on = (query?: object) => splitWhen.refresh!(call(query));
    for (const flag of ['checkFiles', 'checkFileAvailability', 'refreshLocalMediaAgent', 'refreshAnalysis'])
      expect(on({ [flag]: 1 }), flag).toBe(true);
    expect(
      [undefined, { includeChildren: 1 }, { asyncRefreshAnalysis: 0 }, { asyncCheckFiles: 'false' }].map(on),
    ).toEqual([false, false, false, false]);
    expect(
      [{ asyncRefreshAnalysis: 1 }, { asyncAugmentMetadata: 'true' }, { asyncRefreshLocalMediaAgent: true }].map(on),
    ).toEqual([true, true, true]);
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`\s]*)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
