import { OperationDescriptorSchema } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import {
  actionText,
  buildCatalog,
  classify,
  fillTemplate,
  groupOf,
  LOCKED,
  looksLikeAction,
  matchPath,
  parseSpec,
  REVIEWED_READS,
  SpecError,
} from '../src/catalog.js';
import type { OpenApiOperation } from '../src/catalog.js';
import { SPEC_TEXT } from './fake-seerr.js';

const catalog = buildCatalog(SPEC_TEXT);
const op = (key: string) => catalog.operations.find((o) => o.key === key);

describe('classify (SR §2.3, §7 phase 1)', () => {
  it.each([
    ['GET /request', 'read', 'verb:GET'],
    ['POST /request', 'write', 'verb:POST'],
    ['PUT /request/{requestId}', 'write', 'verb:PUT'],
    ['PATCH /anything', 'write', 'verb:PATCH'],
    ['DELETE /request/{requestId}', 'write', 'verb:DELETE'],
  ])('%s → %s', (key, classification, reason) => {
    expect(classify(key)).toMatchObject({ classification, reason, locked: false });
  });

  it('locks the SR §3.4 list regardless of verb, including the GET that resets', () => {
    for (const key of LOCKED) expect(classify(key)).toMatchObject({ classification: 'write', locked: true });
    expect(classify('GET /settings/discover/reset', 'Reset all discover sliders')).toMatchObject({
      classification: 'write',
      locked: true,
      needsReview: true,
    });
    expect(classify('POST /request/{requestId}/{status}#on-behalf').locked).toBe(true);
  });

  it('treats an unreviewed action-shaped GET as a write needing review (fail closed)', () => {
    expect(classify('GET /settings/cache/flush', 'Flush a cache')).toEqual({
      classification: 'write',
      reason: 'heuristic:get-as-action',
      locked: false,
      needsReview: true,
    });
    expect(classify('GET /settings/jellyfin/sync', 'Get status of full Jellyfin library sync')).toMatchObject({
      classification: 'read',
      needsReview: false,
    });
    expect(classify('GET /movie/{movieId}', 'Get movie details')).toMatchObject({ classification: 'read' });
  });
});

describe('library GETs that write (Seerr 3.x)', () => {
  it('locks both, so no call to them runs as a read', () => {
    for (const key of ['GET /settings/plex/library', 'GET /settings/jellyfin/library'])
      expect(op(key)).toMatchObject({ classification: 'write', locked: true, typedConfirmation: true });
  });
});

describe('GET-as-action regression (SR §9)', () => {
  const spec = parseSpec(SPEC_TEXT) as {
    paths: Record<string, Record<string, OpenApiOperation> & { parameters?: unknown[] }>;
  };
  // Summary, description and query parameter descriptions, as the catalog reads them.
  const flagged = Object.entries(spec.paths)
    .flatMap(([path, item]) =>
      item.get ? [[`GET ${path}`, actionText(spec, item.parameters ?? [], item.get)] as const] : [],
    )
    .filter(([key, text]) => looksLikeAction(key, text))
    .map(([key]) => key)
    .sort();

  it('flags exactly the reviewed list in the pinned spec', () => {
    // A new entry here means Seerr shipped an action-shaped GET: review it, then add it to LOCKED or REVIEWED_READS.
    expect(flagged).toEqual([
      'GET /settings/discover/reset',
      'GET /settings/jellyfin/library',
      'GET /settings/jellyfin/sync',
      'GET /settings/plex/library',
    ]);
  });

  it('has a locked or reviewed decision for every flagged GET', () => {
    for (const key of flagged) expect(LOCKED.has(key) || REVIEWED_READS.has(key), key).toBe(true);
  });
});

describe('buildCatalog', () => {
  it('produces a valid descriptor for every operation in the real spec', () => {
    expect(catalog.operations.length).toBe(216); // 212 operations + 4 split keys
    for (const d of catalog.operations) expect(() => OperationDescriptorSchema.parse(d), d.key).not.toThrow();
  });

  it('groups by first tag and carries docs, schemas and the media-request profile', () => {
    expect(op('POST /request')).toMatchObject({
      kind: 'rest',
      group: 'request',
      classification: 'write',
      matchProfile: 'media-request',
      docs: { summary: expect.any(String) },
      paramsSchema: {
        type: 'object',
        properties: { body: { properties: { is4k: { type: 'boolean' }, mediaType: { enum: ['movie', 'tv'] } } } },
      },
    });
    expect(op('GET /user/{userId}')).toMatchObject({
      group: 'users',
      paramsSchema: { properties: { path: { properties: { userId: { type: 'number' } }, required: ['userId'] } } },
    });
    expect(op('GET /settings/main')).toMatchObject({ group: 'settings', classification: 'read' });
  });

  it('adds locked split keys next to the operations whose risk depends on the call', () => {
    expect(op('POST /request/{requestId}/{status}')).toMatchObject({ locked: false, classification: 'write' });
    expect(op('POST /request/{requestId}/{status}#on-behalf')).toMatchObject({
      locked: true,
      typedConfirmation: true,
      group: 'request',
      docs: { description: expect.stringContaining('another Seerr user') },
    });
    expect(op('POST /settings/plex/sync#start')).toMatchObject({ locked: true });
    expect(op('POST /settings/jellyfin/sync#start')).toMatchObject({ locked: true });
    expect(op('POST /settings/jobs/{jobId}/run')).toMatchObject({ locked: false, classification: 'write' });
    expect(op('POST /settings/jobs/{jobId}/run#start')).toMatchObject({
      locked: true,
      docs: { description: expect.stringContaining('heavy or unknown scheduled job') },
    });
  });

  it('rejects a spec that is not OpenAPI 3.0, is not YAML, or is suspiciously small', () => {
    expect(() => buildCatalog('openapi: "2.0"\npaths: {}')).toThrow(SpecError);
    expect(() => buildCatalog('{{{ not yaml')).toThrow(SpecError);
    expect(() => buildCatalog('')).toThrow(SpecError);
    expect(() => buildCatalog('openapi: 3.0.2\npaths:\n  /status:\n    get: {}\n')).toThrow(/only 1 operations/);
  });

  it('uses the first tag as the group', () => {
    expect(groupOf(['Settings'])).toBe('settings');
    expect(groupOf(undefined)).toBe('other');
  });
});

describe('matchPath', () => {
  it.each([
    ['POST', '/request/5/retry', 'POST /request/{requestId}/retry', { requestId: '5' }],
    ['POST', '/api/v1/request/5/approve', 'POST /request/{requestId}/{status}', { requestId: '5', status: 'approve' }],
    ['get', '/user/jellyfin/abc', 'GET /user/jellyfin/{jellyfinUserId}', { jellyfinUserId: 'abc' }],
    ['GET', '/user/7', 'GET /user/{userId}', { userId: '7' }],
    ['GET', '/user/7/', 'GET /user/{userId}', { userId: '7' }],
    ['GET', '/request', 'GET /request', {}],
  ])('%s %s → %s', (method, path, key, pathParams) => {
    expect(matchPath(catalog, method, path)).toMatchObject({ op: { key }, pathParams });
  });

  it.each([
    ['GET', '/user/../settings/main'],
    ['GET', '/user/./7'],
    ['GET', '/user//7'],
    ['GET', '/user/a%2Fb'],
    ['GET', '/nope'],
    ['TRACE', '/request'],
    ['DELETE', '/status'],
  ])('rejects %s %s', (method, path) => {
    expect(matchPath(catalog, method, path)).toBeUndefined();
  });

  it('fills a template with encoded values and refuses a missing one', () => {
    expect(fillTemplate('/user/{userId}/settings', { userId: 'a b' })).toBe('/user/a%20b/settings');
    expect(() => fillTemplate('/user/{userId}', {})).toThrow(/userId/);
  });
});
