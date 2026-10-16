import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockedKeys } from '../src/locks.js';
import { buildCatalog, settings } from '../src/plugin.js';
import { SPEC_TEXT } from './fake-grafana.js';
import { LOCK_CASES } from './locks.js';

/** The catalog from the pinned Grafana v12.4.13 spec: a rename upstream must fail here, not silently unlock. */

const OPERATIONS = 310;
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

describe('Grafana catalog (pinned spec)', () => {
  it('keys every operation by the spec path under /api', () => {
    expect(catalog.operations).toHaveLength(OPERATIONS);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[a-z]/);
  });

  it('has every key plugin.yaml locks, and each one is locked', () => {
    const locked = lockedKeys(settings.rules);
    expect(locked.length).toBeGreaterThan(90);
    for (const key of locked) {
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks exactly the keys the lock cases cover, every delete among them', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    expect(locked.sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
    for (const key of keys) if (key.startsWith('DELETE ')) expect(locked, key).toContain(key);
  });

  it('matches at least one operation with every rule pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out proxies, sign-in flows, public viewer endpoints, renders and the contact point export', () => {
    const excluded = specKeys().filter((k) => !keys.has(k));
    expect(excluded.sort()).toEqual(
      [
        'DELETE /datasources/proxy/uid/{uid}/{datasource_proxy_route}',
        'GET /datasources/proxy/uid/{uid}/{datasource_proxy_route}',
        'POST /datasources/proxy/uid/{uid}/{datasource_proxy_route}',
        'DELETE /datasources/proxy/{id}/{datasource_proxy_route}',
        'GET /datasources/proxy/{id}/{datasource_proxy_route}',
        'POST /datasources/proxy/{id}/{datasource_proxy_route}',
        'GET /datasources/uid/{uid}/resources/{datasource_proxy_route}',
        'GET /datasources/{id}/resources/{datasource_proxy_route}',
        'POST /saml/acs',
        'GET /saml/metadata',
        'GET /saml/slo',
        'POST /saml/slo',
        'GET /logout/saml',
        'GET /public/dashboards/{accessToken}',
        'GET /public/dashboards/{accessToken}/annotations',
        'POST /public/dashboards/{accessToken}/panels/{panelId}/query',
        'GET /user/email/update',
        'GET /reports/render/pdfs',
        'GET /reports/render/csvs',
        'GET /reports/images/:image',
        'GET /v1/provisioning/contact-points/export',
      ].sort(),
    );
  });

  it('reads with GET and writes with every other verb, but for reviewed exceptions; nothing left for review', () => {
    const postReads = [
      'POST /access-control/assignments/search',
      'POST /access-control/teams/roles/search',
      'POST /access-control/users/roles/search',
    ];
    const getWrites = [
      'GET /admin/settings',
      'GET /snapshots-delete/{deleteKey}',
      'GET /licensing/refresh-stats',
      'GET /user/helpflags/clear',
    ];
    for (const o of catalog.operations) {
      const read = o.key.startsWith('GET ') ? !getWrites.includes(o.key) : postReads.includes(o.key);
      expect(o.classification, o.key).toBe(read ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('marks credentials in params and results', () => {
    expect(op('POST /datasources')?.sensitiveParams).toEqual([
      '/body/secureJsonData',
      '/body/basicAuthPassword',
      '/body/password',
    ]);
    expect(op('GET /datasources/uid/{uid}')?.sensitiveResult).toEqual({
      keys: ['secureJsonData', 'basicAuthPassword', 'password'],
      deep: true,
    });
    expect(op('PUT /v1/provisioning/contact-points/{UID}')?.sensitiveParams).toEqual([
      '/body/settings/url',
      '/body/settings/password',
    ]);
    expect(op('GET /org/invites')?.sensitiveResult).toEqual({ keys: ['code', 'url'], deep: true });
    expect(op('POST /ds/query')).toMatchObject({ classification: 'write', locked: false });
    expect(op('GET /v1/provisioning/contact-points')?.sensitiveResult).toEqual({
      keys: ['url'],
      deep: true,
    });
    expect(op('POST /serviceaccounts/{serviceAccountId}/tokens')?.sensitiveResult).toEqual({
      keys: ['key', 'token', 'deleteKey', 'deleteUrl'],
      deep: true,
    });
    expect(op('PUT /admin/users/{user_id}/password')?.sensitiveParams).toEqual(['/body/password']);
  });

  it('locks a delete a newer spec adds', () => {
    const spec = specOf();
    const newer = { ...spec, paths: { ...spec.paths, '/teams/{team_id}/preferences': { delete: { summary: 'x' } } } };
    expect(buildCatalog(newer).operations.find((o) => o.key === 'DELETE /teams/{team_id}/preferences')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('refuses a truncated spec', () => {
    const spec = specOf();
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 100)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });

  it('refuses a spec that lost a locked operation, as after an upstream rename', () => {
    const spec = specOf();
    const { post: _gone, ...rest } = spec.paths['/serviceaccounts/{serviceAccountId}/tokens']!;
    const renamed = { ...spec, paths: { ...spec.paths, '/serviceaccounts/{serviceAccountId}/tokens': rest } };
    expect(() => buildCatalog(renamed)).toThrow(
      /lacks locked operations \(POST \/serviceaccounts\/\{serviceAccountId\}\/tokens\)/,
    );
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
