import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockedKeys } from '../src/locks.js';
import { buildCatalog, settings } from '../src/plugin.js';
import { PLUGIN_IDS, specsOf, SPECS } from './fake-backstage.js';
import { LOCK_CASES } from './locks.js';

/** The merged catalog from the pinned Backstage v1.55.3 specs: a rename upstream must fail here, not silently unlock. */

const { catalog, version } = buildCatalog(specsOf());
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
type Spec = { info: Record<string, unknown>; paths: Record<string, Record<string, unknown>> };
const specOf = (id: string) => JSON.parse(SPECS[id]!) as Spec;
const withSpec = (id: string, spec: unknown) =>
  specsOf().map((s) => (s.id === id ? { id, spec: spec as Record<string, unknown> } : s));

const READ_POSTS = [
  'POST /api/catalog/validate-entity',
  'POST /api/catalog/analyze-location',
  'POST /api/catalog/entities/by-refs',
  'POST /api/catalog/entities/by-query',
  'POST /api/catalog/entity-facets',
  'POST /api/catalog/locations/by-query',
  'POST /api/scaffolder/v2/autocomplete/{provider}/{resource}',
];

describe('Backstage catalog (pinned specs)', () => {
  it('keys every operation by its full served path, grouped by tag or plugin', () => {
    expect(catalog.operations).toHaveLength(41);
    expect(version).toBe('1');
    for (const o of catalog.operations) {
      expect(o.key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/(catalog|scaffolder|search|events|notifications)\//);
      expect(o.group, o.key).not.toBe('other');
    }
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(9);
    for (const key of locked) {
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks exactly the keys the e2e lock cases cover', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    expect(locked.sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
  });

  it('matches at least one operation with every rule pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out notifications legacy routes and the events subscription plumbing', () => {
    for (const key of [
      'GET /api/notifications/',
      'POST /api/notifications/',
      'POST /api/notifications/update',
      'GET /api/notifications/{id}',
      'PUT /api/events/bus/v1/subscriptions/{subscriptionId}',
      'GET /api/events/bus/v1/subscriptions/{subscriptionId}/events',
    ])
      expect(keys.has(key), key).toBe(false);
    const specKeys = PLUGIN_IDS.flatMap((id) =>
      Object.entries(specOf(id).paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((verb) => verb !== 'parameters')
          .map((verb) => `${verb.toUpperCase()} ${path}`),
      ),
    );
    expect(specKeys.length - keys.size).toBe(6);
  });

  it('reads with GET and the reviewed query and validation POSTs; every other verb, dry-run included, writes', () => {
    for (const o of catalog.operations) {
      const read = o.key.startsWith('GET ') || READ_POSTS.includes(o.key);
      expect(o.classification, o.key).toBe(read ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('marks template and SCM secrets in params, and task secrets in results', () => {
    for (const key of [
      'POST /api/scaffolder/v2/dry-run',
      'POST /api/scaffolder/v2/tasks',
      'POST /api/scaffolder/v2/tasks/{taskId}/retry',
    ])
      expect(op(key)?.sensitiveParams, key).toEqual(['/body/secrets']);
    expect(op('POST /api/catalog/refresh')?.sensitiveParams).toEqual(['/body/authorizationToken']);
    expect(op('POST /api/scaffolder/v2/autocomplete/{provider}/{resource}')?.sensitiveParams).toEqual(['/body/token']);
    expect(op('GET /api/scaffolder/v2/tasks/{taskId}')?.sensitiveResult).toEqual({ keys: ['secrets'], deep: true });
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf('scaffolder');
    spec.paths['/api/scaffolder/v2/tasks/{taskId}'] = {
      ...spec.paths['/api/scaffolder/v2/tasks/{taskId}'],
      delete: { summary: 'Delete task', responses: {} },
    };
    expect(
      buildCatalog(withSpec('scaffolder', spec)).catalog.operations.find(
        (o) => o.key === 'DELETE /api/scaffolder/v2/tasks/{taskId}',
      ),
    ).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it('refuses a spec that lost a locked operation, as after an upstream rename', () => {
    const spec = specOf('catalog');
    const { delete: _gone, ...rest } = spec.paths['/api/catalog/locations/{id}']!;
    spec.paths['/api/catalog/locations/{id}'] = rest;
    expect(() => buildCatalog(withSpec('catalog', spec))).toThrow(
      /lacks locked operations \(DELETE \/api\/catalog\/locations\/\{id\}\)/,
    );
  });

  it("refuses a plugin's spec with a path outside its own /api/<plugin>", () => {
    const spec = specOf('search');
    spec.paths['/api/catalog/locations'] = { get: { responses: {} } };
    expect(() => buildCatalog(withSpec('search', spec))).toThrow(/search API spec has a path outside \/api\/search/);
  });

  it('builds from a subset of plugins, keeping only their locks', () => {
    const { catalog: some } = buildCatalog(specsOf(['catalog', 'search']));
    expect(some.operations.every((o) => /^\S+ \/api\/(catalog|search)\//.test(o.key))).toBe(true);
    expect(some.operations.filter((o) => o.locked)).toHaveLength(4);
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`\s?]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
