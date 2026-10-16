import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockedKeys } from '../src/locks.js';
import { buildCatalog, settings } from '../src/plugin.js';
import { LOCK_CASES } from './locks.js';
import { SPEC_TEXT } from './fake-profilarr.js';

/** The catalog from the pinned Profilarr v2.2.0 spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };

describe('Profilarr catalog (pinned spec)', () => {
  it('keys every operation by the spec path under /api/v1', () => {
    expect(catalog.operations).toHaveLength(17);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[a-z]/);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked).toHaveLength(6);
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

  it('leaves out the spec route, the binary download and the multipart upload', () => {
    for (const key of ['GET /openapi.json', 'GET /backups/{filename}', 'POST /backups/upload'])
      expect(keys.has(key), key).toBe(false);
    const specKeys = Object.entries(specOf().paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((verb) => verb !== 'parameters')
        .map((verb) => `${verb.toUpperCase()} ${path}`),
    );
    expect(specKeys.length - keys.size).toBe(3);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      const isGet = o.key.startsWith('GET ');
      expect(o.classification, o.key).toBe(isGet ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('marks the database token in params and results, and arr API keys in results', () => {
    expect(op('POST /databases')?.sensitiveParams).toEqual(['/body/personal_access_token']);
    expect(op('PATCH /databases/{id}')?.sensitiveParams).toEqual(['/body/personal_access_token']);
    expect(op('GET /databases/{id}')?.sensitiveResult).toEqual({ keys: ['personal_access_token'], deep: true });
    expect(op('GET /arr')?.sensitiveResult).toEqual({ keys: ['api_key'], deep: true });
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/arr/{id}': { delete: { summary: 'Delete Arr Instance' } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /arr/{id}')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('refuses a truncated spec', () => {
    const spec = specOf();
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 5)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });

  it('refuses a spec that lost a locked operation, as after an upstream rename', () => {
    const spec = specOf();
    const { delete: _gone, ...rest } = spec.paths['/backups/{filename}']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/backups/{filename}': rest } };
    expect(() => buildCatalog(renamed)).toThrow(/lacks locked operations \(DELETE \/backups\/\{filename\}\)/);
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
