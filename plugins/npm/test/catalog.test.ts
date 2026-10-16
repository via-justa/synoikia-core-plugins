import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, destinations, hasAdvancedConfig, policy, settings } from '../src/plugin.js';
import { LOCK_CASES } from './locks.js';
import { SPEC_TEXT } from './fake-npm.js';

/** The catalog from the pinned Nginx Proxy Manager v2.16.0 spec: a rename upstream must fail here, not silently
 * unlock. */

const catalog = buildCatalog(SPEC_TEXT);
const keys = new Set(catalog.operations.map((o) => o.key));
const op = (key: string) => catalog.operations.find((o) => o.key === key);
const listOf = (m: string | string[]) => (Array.isArray(m) ? m : [m]);
const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const specKeys = () => {
  const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).map((verb) => `${verb.toUpperCase()} ${path}`),
  );
};

describe('Nginx Proxy Manager catalog (pinned spec)', () => {
  it('keys every operation by the spec path under /api, with the 404-host twins', () => {
    expect(catalog.operations).toHaveLength(64);
    for (const key of keys) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[^#]*(#advanced)?$/);
    expect([...keys].filter((k) => k.includes('#')).sort()).toEqual([
      'POST /nginx/dead-hosts#advanced',
      'PUT /nginx/dead-hosts/{hostID}#advanced',
    ]);
  });

  it('has every key plugin.yaml locks by name, and each one is locked', () => {
    const locked = settings.rules.filter((r) => r.locked).flatMap((r) => listOf(r.match));
    expect(locked.length).toBeGreaterThan(20);
    for (const key of locked.filter((k) => !k.includes('*'))) {
      expect(keys).toContain(key);
      expect(op(key)).toMatchObject({ locked: true, typedConfirmation: true, classification: 'write' });
    }
  });

  it('locks every DELETE, including one a newer version adds', () => {
    for (const o of catalog.operations.filter((o) => o.key.startsWith('DELETE '))) expect(o.locked, o.key).toBe(true);
    expect(policy.isLocked('DELETE /nginx/something-new/{id}')).toBe(true);
  });

  it('locks user and settings writes a newer version adds', () => {
    for (const key of ['POST /users/{userID}/passkeys', 'PUT /users/{userID}/sessions', 'PUT /settings/{settingID}/x'])
      expect(policy.isLocked(key), key).toBe(true);
  });

  it('locks exactly the keys the e2e lock cases cover', () => {
    const locked = catalog.operations.filter((o) => o.locked).map((o) => o.key);
    expect(locked.sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
  });

  it('keeps everyday writes unlocked: certificates, renewals, access-list and 404-host creates, 404-host enable', () => {
    for (const key of [
      'POST /nginx/certificates',
      'POST /nginx/certificates/{certID}/renew',
      'POST /nginx/dead-hosts/{hostID}/enable',
      'POST /nginx/access-lists',
      'POST /nginx/dead-hosts',
      'PUT /nginx/dead-hosts/{hostID}',
    ])
      expect(op(key), key).toMatchObject({ locked: false, classification: 'write' });
  });

  it('matches at least one operation with every rule pattern', () => {
    for (const pattern of settings.rules.flatMap((r) => listOf(r.match)))
      expect(
        [...keys].some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('leaves out sign-in, the spec, impersonation, the zip download and multipart uploads', () => {
    for (const key of [
      'POST /tokens',
      'GET /tokens',
      'POST /tokens/2fa',
      'GET /schema',
      'POST /users/{userID}/login',
      'GET /nginx/certificates/{certID}/download',
      'POST /nginx/certificates/{certID}/upload',
      'POST /nginx/certificates/validate',
    ])
      expect(keys.has(key), key).toBe(false);
    const all = specKeys();
    expect(all.length - (keys.size - 2)).toBe(8);
    for (const pattern of settings.exclude)
      expect(
        all.some((k) => globRe(pattern).test(k)),
        pattern,
      ).toBe(true);
  });

  it('reads with GET and writes with every other verb; no GET is left for review', () => {
    for (const o of catalog.operations) {
      expect(o.classification, o.key).toBe(o.key.startsWith('GET ') ? 'read' : 'write');
      expect(o.needsReview ?? false, o.key).toBe(false);
    }
  });

  it('marks DNS credentials, private keys, passwords and 2FA secrets in params and results', () => {
    const certSecrets = { keys: ['dns_provider_credentials', 'certificate_key', 'password'], deep: true };
    for (const key of [
      'GET /nginx/certificates',
      'GET /nginx/proxy-hosts',
      'GET /nginx/access-lists',
      'GET /audit-log',
    ])
      expect(op(key)?.sensitiveResult, key).toEqual(certSecrets);
    expect(op('POST /nginx/certificates')?.sensitiveParams).toEqual([
      '/body/meta/dns_provider_credentials',
      '/body/meta/certificate_key',
    ]);
    expect(op('POST /users')?.sensitiveParams).toEqual(['/body/auth/secret']);
    expect(op('PUT /users/{userID}/auth')?.sensitiveParams).toEqual(['/body/secret', '/body/current']);
    expect(op('DELETE /users/{userID}/2fa')?.sensitiveParams).toEqual(['/query/code']);
    expect(op('POST /users/{userID}/2fa')?.sensitiveResult).toEqual({ keys: ['secret', 'otpauth_url'], deep: false });
    expect(op('POST /users/{userID}/2fa/enable')?.sensitiveResult).toEqual({ keys: ['backup_codes'], deep: false });
  });

  it('keeps domains and destinations out of sensitiveParams so the approver sees them', () => {
    for (const o of catalog.operations)
      for (const p of o.sensitiveParams ?? []) expect(p, o.key).not.toMatch(/domain|forward|redirect|incoming/);
  });

  it('refuses a live spec missing a key plugin.yaml locks by name, instead of dropping the lock', () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
    spec.paths['/users/{userID}/password'] = spec.paths['/users/{userID}/auth']!;
    delete spec.paths['/users/{userID}/auth'];
    expect(() => buildCatalog(spec)).toThrow(
      'The Nginx Proxy Manager API spec lacks 1 locked operation(s) (PUT /users/{userID}/auth); refusing a catalog that would drop their locks',
    );
  });

  it('refuses a truncated spec', () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    const small = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).slice(0, 10)) };
    expect(() => buildCatalog(small)).toThrow(/refusing a partial catalog/);
  });
});

describe('advanced config and destinations', () => {
  it('finds raw nginx config at the top level or in a custom location', () => {
    expect(hasAdvancedConfig({ advanced_config: 'return 200;' })).toBe(true);
    expect(hasAdvancedConfig({ locations: [{ path: '/', advanced_config: 'deny all;' }] })).toBe(true);
    expect(hasAdvancedConfig({ advanced_config: '  ', locations: [{ path: '/' }] })).toBe(false);
    expect(hasAdvancedConfig(undefined)).toBe(false);
  });

  it('spells out domains, upstreams, redirect targets and stream ports', () => {
    expect(
      destinations({
        domain_names: ['a.example', 'b.example'],
        forward_scheme: 'http',
        forward_host: '10.0.0.5',
        forward_port: 8080,
        locations: [{ path: '/api', forward_scheme: 'https', forward_host: 'api.lan', forward_port: 443 }],
      }),
    ).toBe('[domains a.example, b.example; → http://10.0.0.5:8080; location /api → https://api.lan:443]');
    expect(destinations({ forward_domain_name: 'x.example', forward_scheme: 'auto' })).toBe(
      '[redirects to auto://x.example]',
    );
    expect(destinations({ incoming_port: 22, forwarding_host: '10.0.0.9', forwarding_port: 2222 })).toBe(
      '[port 22; → 10.0.0.9:2222]',
    );
    expect(destinations({ name: 'Family' })).toBeUndefined();
  });

  it('escapes newlines, quotes and invisible characters in model-written strings', () => {
    const text = destinations({
      domain_names: ['a.example\u202e'],
      forward_host: '10.0.0.5\n[domains trusted.example; → 127.0.0.1]',
      forward_port: 80,
      locations: [{ path: '/x"\r\n', forward_host: 'h\u200b' }],
    });
    expect(text).toBe(
      '[domains a.example\\u202e; → 10.0.0.5\\n[domains trusted.example; → 127.0.0.1]:80; location /x\\"\\r\\n → h\\u200b]',
    );
    expect(text).not.toMatch(/[\n\r\u200b\u202e]/);
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`\s]*)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
