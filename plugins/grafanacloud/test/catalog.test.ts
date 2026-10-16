import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockedKeys } from '../src/locks.js';
import { buildCatalog, settings } from '../src/plugin.js';
import { SPEC_TEXT } from './fake-grafanacloud.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned grafana.com spec (grafana/grafana-com-public-clients 3d5e6ef, 2026-09-22): a
 * rename upstream must fail here, not silently unlock. */

const OPERATIONS = 54;
const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
const specKeys = () =>
  Object.entries(specOf().paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((verb) => verb !== 'parameters')
      .map((verb) => `${verb.toUpperCase()} ${path}`),
  );

describe('Grafana Cloud catalog (pinned spec)', () => {
  it('keys every operation by the spec path under /api', () => {
    expect(catalog.operations).toHaveLength(OPERATIONS);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|DELETE) \/[a-z]/);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(15);
    for (const key of locked) {
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks exactly the keys the lock cases cover: every write, every delete', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    expect(locked.sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
    for (const o of catalog.operations) if (o.classification === 'write') expect(o.locked, o.key).toBe(true);
  });

  it('matches at least one operation with every rule pattern, but the verbs the spec does not use yet', () => {
    for (const pattern of settings.rules
      .flatMap((r) => listOf(r.match))
      .filter((m) => m !== 'PUT *' && m !== 'PATCH *'))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('locks every non-GET operation but the stack URL check', () => {
    for (const o of catalog.operations)
      if (!o.key.startsWith('GET ') && o.key !== 'POST /v1/stacks/checkUrl')
        expect(o, o.key).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
  });

  it('leaves out only the org visibility check', () => {
    expect(specKeys().filter((k) => !keys.has(k))).toEqual(['GET /orgs/{slugOrId}/check-visibility']);
  });

  it('reads with GET and the stack URL check, writes with every other call; nothing left for review', () => {
    for (const o of catalog.operations) {
      const read = o.key.startsWith('GET ') || o.key === 'POST /v1/stacks/checkUrl';
      expect(o.classification, o.key).toBe(read ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('masks new tokens and stack secrets in results', () => {
    expect(op('POST /v1/tokens')?.sensitiveResult).toEqual({ keys: ['token'], deep: true });
    expect(op('POST /instances/{instanceId}/api/serviceaccounts/{serviceAccountId}/tokens')?.sensitiveResult).toEqual({
      keys: ['key'],
      deep: true,
    });
    for (const key of [
      'GET /instances',
      'GET /instances/{instanceId}',
      'GET /orgs/{orgSlug}/instances',
      'POST /instances',
    ])
      expect(op(key)?.sensitiveResult, key).toEqual({ keys: ['machineLearningLogsToken', 'config'], deep: true });
  });

  it('locks a delete, PUT or PATCH a newer spec adds', () => {
    const spec = specOf();
    const labels = { delete: { summary: 'x' }, put: { summary: 'x' }, patch: { summary: 'x' } };
    const newer = { ...spec, paths: { ...spec.paths, '/v1/stacks/{idOrSlug}/labels': labels } };
    const ops = buildCatalog(newer).operations;
    for (const verb of ['DELETE', 'PUT', 'PATCH'])
      expect(
        ops.find((o) => o.key === `${verb} /v1/stacks/{idOrSlug}/labels`),
        verb,
      ).toMatchObject({
        locked: true,
        typedConfirmation: true,
      });
  });

  it('refuses a truncated spec', () => {
    const spec = specOf();
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 10)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });

  it('refuses a spec that lost a locked operation, as after an upstream rename', () => {
    const spec = specOf();
    const { post: _gone, ...rest } = spec.paths['/v1/tokens']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/v1/tokens': rest } };
    expect(() => buildCatalog(renamed)).toThrow(/lacks locked operations \(POST \/v1\/tokens\)/);
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`\s]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
