import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, settings } from '../src/plugin.js';
import { LOCK_CASES } from './locks.js';
import { SPEC_TEXT } from './fake-mealie.js';

/** The catalog from the pinned Mealie v3.28.0 spec: a rename upstream must fail here, not silently unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const ruleKeys = (pick: (r: (typeof settings.rules)[number]) => unknown) =>
  settings.rules.filter(pick).flatMap((r) => listOf(r.match));
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

describe('Mealie catalog (pinned spec)', () => {
  it('keys every operation by the spec path, under /api', () => {
    expect(catalog.operations).toHaveLength(235);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\//);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = ruleKeys((r) => r.locked).filter((k) => !k.includes('*'));
    expect(locked.length).toBeGreaterThan(0);
    for (const key of locked) {
      expect(key).not.toContain('*');
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks exactly the keys the e2e lock cases cover', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    expect(locked.sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
  });

  it('matches at least one operation with every rule and include pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out plumbing: sign-in, sign-up, file serving, debug, multipart and streams', () => {
    for (const key of [
      'POST /api/auth/token',
      'GET /api/auth/oauth/callback',
      'POST /api/users/register',
      'POST /api/users/forgot-password',
      'GET /api/media/recipes/{recipe_id}/images/{file_name}',
      'GET /api/utils/download',
      'GET /api/admin/backups/{file_name}',
      'POST /api/admin/backups/upload',
      'POST /api/admin/debug/openai/{provider_id}',
      'POST /api/recipes/create/url/stream',
      'POST /api/recipes/create/zip',
    ])
      expect(keys.has(key), key).toBe(false);
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
    const specKeys = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item).map((verb) => `${verb.toUpperCase()} ${path}`),
    );
    expect(specKeys.length - keys.size).toBe(31);
    for (const pattern of settings.exclude)
      expect(
        specKeys.some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      const isGet = o.key.startsWith('GET ');
      expect(o.classification, o.key).toBe(isGet ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('marks token, password and webhook secrets in params and results', () => {
    expect(op('POST /api/users/api-tokens')?.sensitiveResult).toEqual({ keys: ['token'], deep: false });
    expect(op('POST /api/admin/users/password-reset-token')?.sensitiveResult).toEqual({
      keys: ['token'],
      deep: false,
    });
    expect(op('GET /api/admin/about')?.sensitiveResult).toEqual({ keys: ['dbUrl'], deep: false });
    expect(op('GET /api/households/webhooks')?.sensitiveResult).toEqual({ keys: ['url'], deep: true });
    expect(op('GET /api/households/self')?.sensitiveResult).toEqual({ keys: ['url'], deep: true });
    expect(op('PUT /api/users/password')?.sensitiveParams).toEqual(['/body/currentPassword', '/body/newPassword']);
    expect(op('POST /api/groups/ai-providers/providers')?.sensitiveParams).toContain('/body/apiKey');
    expect(op('POST /api/households/events/notifications')?.sensitiveParams).toEqual(['/body/appriseUrl']);
  });

  it('refuses a live spec missing a key plugin.yaml locks by name, instead of dropping the lock', () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
    const restore = spec.paths['/api/admin/backups/{file_name}/restore']!;
    spec.paths['/api/admin/backups/{file_name}/restore-v2'] = restore;
    delete spec.paths['/api/admin/backups/{file_name}/restore'];
    expect(() => buildCatalog(spec)).toThrow(
      'The Mealie API spec lacks 1 locked operation(s) (POST /api/admin/backups/{file_name}/restore); refusing a catalog that would drop their locks',
    );
  });

  it('shows webhook and AI provider destinations to the approver, masking webhook urls only in results', () => {
    expect(op('PUT /api/households/webhooks/{item_id}')).toMatchObject({
      locked: true,
      sensitiveResult: { keys: ['url'] },
    });
    expect(op('PUT /api/households/webhooks/{item_id}')?.sensitiveParams).toBeUndefined();
    expect(op('PUT /api/groups/ai-providers/providers/{provider_id}')?.sensitiveParams).not.toContain('/body/baseUrl');
  });

  it('locks every delete, one a newer spec adds included', () => {
    for (const o of catalog.operations.filter((o) => o.key.startsWith('DELETE ')))
      expect(o, o.key).toMatchObject({ locked: true, typedConfirmation: true });
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    const newer = { ...spec, paths: { ...spec.paths, '/api/pantry/{item_id}': { delete: { summary: 'Delete' } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /api/pantry/{item_id}')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('refuses a truncated spec', () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 10)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
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
