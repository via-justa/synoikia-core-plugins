import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Nginx Proxy Manager: the pinned v2.16.0 spec at /api/schema, JWT sign-in at /api/tokens, the endpoints
 * the tests call, and responses holding secrets that must never reach the sandbox. */

export const EMAIL = 'synoikia@example.com';
export const PASSWORD = 'npm-password-000000';
export const CREDENTIALS = { email: EMAIL, password: PASSWORD };

export const SPEC_TEXT = readFileSync(new URL('./fixtures/npm-openapi.json', import.meta.url), 'utf8');

/** Secrets the fake returns (real NPM omits or masks most of them; the plugin masks them regardless). */
export const SECRETS = {
  dnsCredentials: 'dns_cloudflare_api_token = cf-token-111111',
  privateKey: '-----BEGIN PRIVATE KEY----- private-key-222222',
  basicAuthPassword: 'basic-auth-pw-333333',
  totpSecret: 'TOTPSECRET444444',
  backupCode: 'BACKUP55',
};

export const PROXY_HOST = {
  id: 1,
  domain_names: ['app.home.example'],
  forward_scheme: 'http',
  forward_host: '10.0.0.5',
  forward_port: 8080,
  certificate_id: 1,
  enabled: true,
};
export const ALEX = { id: 2, email: 'alex@home.example', name: 'Alex' };

interface Host {
  id: number;
  domain_names: string[];
  enabled: boolean;
  [field: string]: unknown;
}

export interface FakeNpm extends FakeHttp {
  proxyHosts: Map<number, Host>;
  users: Map<number, { id: number; email: string; name: string }>;
  /** Successful sign-ins so far. */
  signIns: number;
  /** Invalidates the current JWT, as an expired or revoked one. */
  expireToken(): void;
  /** Answers sign-in with a 2FA challenge, as for a user with two-factor authentication on. */
  twoFactor: boolean;
  /** Lifetime of the next tokens it issues. */
  tokenLifetimeMs: number;
  /** Paths answered 403, as for a user without the permission. */
  denied: Set<string>;
  /** Replaces what /api/schema serves (to test validation). */
  serveSpec(spec: unknown): void;
}

const ok = (body: unknown = true): FakeResponse => ({ body });
const notFound: FakeResponse = { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
const id = (req: FakeRequest, name: string) => Number(req.params[name]);

export async function startFakeNpm(): Promise<FakeNpm> {
  let spec: unknown = JSON.parse(SPEC_TEXT);
  let generation = 0;
  let token = '';
  const denied = new Set<string>();
  const certificate = {
    id: 1,
    provider: 'letsencrypt',
    nice_name: 'Home wildcard',
    domain_names: ['*.home.example'],
    meta: {
      dns_challenge: true,
      dns_provider: 'cloudflare',
      dns_provider_credentials: SECRETS.dnsCredentials,
      certificate_key: SECRETS.privateKey,
    },
  };
  const proxyHosts = new Map<number, Host>([[1, { ...PROXY_HOST }]]);
  const redirectionHosts = new Map<number, Host>([
    [1, { id: 1, domain_names: ['old.home.example'], forward_domain_name: 'new.home.example', enabled: true }],
  ]);
  const deadHosts = new Map<number, Host>([[1, { id: 1, domain_names: ['gone.home.example'], enabled: true }]]);
  const streams = new Map([[1, { id: 1, incoming_port: 2222, forwarding_host: '10.0.0.9', forwarding_port: 22 }]]);
  const accessLists = new Map([
    [1, { id: 1, name: 'Family', items: [{ username: 'kid', password: SECRETS.basicAuthPassword }] }],
  ]);
  const users = new Map([
    [1, { id: 1, email: EMAIL, name: 'Synoikia' }],
    [2, { ...ALEX }],
  ]);
  const withCert = (req: FakeRequest, host: Host) =>
    (req.query.get('expand') ?? '').includes('certificate') && host.certificate_id === 1
      ? { ...host, certificate }
      : host;
  const one =
    <T>(map: Map<number, T>, param: string) =>
    (req: FakeRequest) => {
      const row = map.get(id(req, param));
      return row ? ok(row) : notFound;
    };
  const remove =
    <T>(map: Map<number, T>, param: string) =>
    (req: FakeRequest) =>
      map.delete(id(req, param)) ? ok(true) : notFound;
  const user = (req: FakeRequest) => {
    const row = users.get(req.params.userID === 'me' ? 1 : id(req, 'userID'));
    return row ? ok(row) : notFound;
  };
  const twoFactor = () => ok({ backup_codes: [SECRETS.backupCode, 'BACKUP66'] });

  const fake = await startFakeHttp({
    // The health check, the spec and sign-in are public; everything else needs the current JWT.
    guard: (req) => {
      if (req.path === '/api/' || req.path === '/api/schema' || req.path === '/api/tokens') return undefined;
      if (!token || req.headers.authorization !== `Bearer ${token}`)
        return { status: 401, body: { error: { code: 401, message: 'Permission Denied' } } };
      return denied.has(req.path)
        ? { status: 403, body: { error: { code: 403, message: 'Permission Denied' } } }
        : undefined;
    },
    routes: {
      'GET /api/': () => ok({ status: 'OK', setup: true, version: { major: 2, minor: 16, revision: 0 } }),
      'GET /api/schema': () => ok(spec),
      'POST /api/tokens': (req) => {
        const body = req.body as { identity?: unknown; secret?: unknown } | undefined;
        if (body?.identity !== EMAIL || body.secret !== PASSWORD)
          return { status: 401, body: { error: { code: 401, message: 'Invalid email or password' } } };
        if (result.twoFactor) return ok({ requires_2fa: true, challenge_token: 'challenge-999999' });
        generation += 1;
        token = `jwt-${generation}`;
        result.signIns += 1;
        return ok({ token, expires: new Date(Date.now() + result.tokenLifetimeMs).toISOString() });
      },
      'GET /api/users/{userID}': user,
      'GET /api/users': () => ok([...users.values()]),
      'POST /api/users': (req) => ok({ id: 3, ...(req.body as object) }),
      'PUT /api/users/{userID}': user,
      'DELETE /api/users/{userID}': remove(users, 'userID'),
      'PUT /api/users/{userID}/auth': () => ok(true),
      'PUT /api/users/{userID}/permissions': () => ok(true),
      'POST /api/users/{userID}/2fa': () =>
        ok({ secret: SECRETS.totpSecret, otpauth_url: `otpauth://totp/NPM?secret=${SECRETS.totpSecret}` }),
      'DELETE /api/users/{userID}/2fa': () => ok(true),
      'POST /api/users/{userID}/2fa/enable': twoFactor,
      'POST /api/users/{userID}/2fa/backup-codes': twoFactor,
      'GET /api/nginx/proxy-hosts': (req) => ok([...proxyHosts.values()].map((h) => withCert(req, h))),
      'GET /api/nginx/proxy-hosts/{hostID}': one(proxyHosts, 'hostID'),
      'POST /api/nginx/proxy-hosts': (req) => ok({ id: 2, ...(req.body as object) }),
      'PUT /api/nginx/proxy-hosts/{hostID}': (req) =>
        ok({ ...proxyHosts.get(id(req, 'hostID')), ...(req.body as object) }),
      'DELETE /api/nginx/proxy-hosts/{hostID}': remove(proxyHosts, 'hostID'),
      'POST /api/nginx/proxy-hosts/{hostID}/disable': () => ok(true),
      'POST /api/nginx/proxy-hosts/{hostID}/enable': () => ok(true),
      'GET /api/nginx/redirection-hosts/{hostID}': one(redirectionHosts, 'hostID'),
      'POST /api/nginx/redirection-hosts': (req) => ok({ id: 2, ...(req.body as object) }),
      'PUT /api/nginx/redirection-hosts/{hostID}': (req) => ok(req.body),
      'DELETE /api/nginx/redirection-hosts/{hostID}': one(redirectionHosts, 'hostID'),
      'POST /api/nginx/redirection-hosts/{hostID}/disable': () => ok(true),
      'POST /api/nginx/redirection-hosts/{hostID}/enable': () => ok(true),
      'GET /api/nginx/dead-hosts/{hostID}': one(deadHosts, 'hostID'),
      'POST /api/nginx/dead-hosts': (req) => ok({ id: 2, ...(req.body as object) }),
      'PUT /api/nginx/dead-hosts/{hostID}': (req) => ok(req.body),
      'DELETE /api/nginx/dead-hosts/{hostID}': one(deadHosts, 'hostID'),
      'POST /api/nginx/dead-hosts/{hostID}/disable': () => ok(true),
      'GET /api/nginx/streams/{streamID}': one(streams, 'streamID'),
      'POST /api/nginx/streams': (req) => ok({ id: 2, ...(req.body as object) }),
      'PUT /api/nginx/streams/{streamID}': (req) => ok(req.body),
      'DELETE /api/nginx/streams/{streamID}': one(streams, 'streamID'),
      'POST /api/nginx/streams/{streamID}/disable': () => ok(true),
      'POST /api/nginx/streams/{streamID}/enable': () => ok(true),
      'GET /api/nginx/certificates': () => ok([certificate]),
      'GET /api/nginx/certificates/{certID}': (req) => (id(req, 'certID') === 1 ? ok(certificate) : notFound),
      'POST /api/nginx/certificates': (req) => ok({ id: 2, ...(req.body as object) }),
      'POST /api/nginx/certificates/{certID}/renew': () => ok(certificate),
      'DELETE /api/nginx/certificates/{certID}': () => ok(true),
      'GET /api/nginx/access-lists': () => ok([...accessLists.values()]),
      'GET /api/nginx/access-lists/{listID}': one(accessLists, 'listID'),
      'POST /api/nginx/access-lists': (req) => ok({ id: 2, ...(req.body as object) }),
      'PUT /api/nginx/access-lists/{listID}': (req) => ok({ id: id(req, 'listID'), ...(req.body as object) }),
      'DELETE /api/nginx/access-lists/{listID}': one(accessLists, 'listID'),
      'GET /api/audit-log': () =>
        ok([{ id: 1, action: 'created', object_type: 'certificate', meta: { ...certificate.meta } }]),
      'PUT /api/settings/{settingID}': (req) => ok({ id: req.params.settingID, ...(req.body as object) }),
    },
  });
  const result: FakeNpm = {
    ...fake,
    proxyHosts,
    users,
    signIns: 0,
    twoFactor: false,
    tokenLifetimeMs: 24 * 60 * 60_000,
    denied,
    expireToken: () => {
      token = `expired-${generation}`;
    },
    serveSpec: (next) => {
      spec = next;
    },
  };
  return result;
}
