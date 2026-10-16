import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeResponse, FakeRoute } from '@synoikia/core/testing';

/** A fake grafana.com API: the pinned spec at /api/openapi.json (also a fixed copy, a broken and a non-JSON
 * source, for the fallback), Bearer auth on the rest of /api, named records for confirmation and target lookups, responses
 * holding secrets, and `{ message }` for every other operation in the spec. */

export const FAKE_TOKEN = 'glc_fake-cloud-access-policy-token-abcdef';
export const CREDENTIALS = { token: FAKE_TOKEN };
export const ORG = 'acme';
export const REGION = 'prod-us-east-0';
/** The pinned spec's `info.version`. */
export const VERSION = 'public';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/grafana-com-openapi.json', import.meta.url), 'utf8');

export const SECRETS = {
  cloudToken: 'glc_new-cloud-token-111111',
  saToken: 'glsa_new-stack-service-account-key-222222',
  mlLogsToken: 'ml-logs-token-333333',
  configSecret: 'oauth-client-secret-444444',
};

export const STACK = {
  id: 101,
  slug: 'acme-prod',
  name: 'Acme Production',
  url: 'https://acme-prod.grafana.net',
  orgId: 7,
  orgSlug: ORG,
  regionSlug: REGION,
  status: 'active',
  machineLearningLogsToken: SECRETS.mlLogsToken,
  config: { auth: { generic_oauth: { client_id: 'acme', client_secret: SECRETS.configSecret } } },
};

export const POLICY = {
  id: 'ap-1',
  name: 'stack-readers',
  scopes: ['metrics:read', 'logs:read'],
  realms: [{ type: 'stack', identifier: '101', labelPolicies: [{ selector: '{env="prod"}' }] }],
};

export interface FakeGrafanaCloud extends FakeHttp {
  /** Paths answered 403. */
  denied: Set<string>;
  /** Replaces what /api/openapi.json serves (to test validation). */
  serveSpec(spec: unknown): void;
}

const ok = (body: unknown = { message: 'ok' }): FakeResponse => ({ body });
const notFound: FakeResponse = { status: 404, body: { message: 'not found' } };
const byId =
  <T>(param: string, rows: Record<string, T>): FakeRoute =>
  (req) => {
    const row = rows[req.params[param] ?? ''];
    return row ? ok(row) : notFound;
  };
/** Access policies and tokens are regional: grafana.com refuses a call without `region`. */
const regional =
  <T>(rows: Record<string, T>): FakeRoute =>
  (req) => {
    if (req.query.get('region') !== REGION) return { status: 400, body: { message: 'region is required' } };
    const row = rows[req.params.id ?? ''];
    return row ? ok(row) : notFound;
  };

/** Literal segments before `{params}`, left to right, as the SDK routes; the fake takes the first match. */
function bySpecificity([a]: [string, FakeRoute], [b]: [string, FakeRoute]) {
  const sa = a.split(' ')[1]!.split('/');
  const sb = b.split(' ')[1]!.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const pa = sa[i]!.startsWith('{');
    const pb = sb[i]!.startsWith('{');
    if (pa !== pb) return pa ? 1 : -1;
  }
  return 0;
}

export async function startFakeGrafanaCloud(): Promise<FakeGrafanaCloud> {
  let spec: unknown = JSON.parse(SPEC_TEXT);
  const denied = new Set<string>();
  const stacks = { [STACK.slug]: STACK, [String(STACK.id)]: STACK };

  const routes: Record<string, FakeRoute> = {
    'GET /api/openapi.json': () => ok(spec),
    'GET /pinned/openapi.json': () => ({ body: SPEC_TEXT, headers: { 'content-type': 'application/json' } }),
    'GET /broken/openapi.json': () => ({ status: 503, body: { message: 'unavailable' } }),
    'GET /html/openapi.json': () => ({ body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } }),
    'GET /api/orgs/{slugOrId}': byId('slugOrId', {
      [ORG]: { id: 7, slug: ORG, name: 'Acme Corp' },
      '7': { id: 7, slug: ORG, name: 'Acme Corp' },
    }),
    'GET /api/orgs/{slugOrId}/members/{usernameOrId}': byId('usernameOrId', {
      alex: { userId: 3, userUsername: 'alex', userName: 'Alex Doe', role: 'Viewer', orgSlug: ORG },
    }),
    'GET /api/instances': () => ok({ items: [STACK], total: 1, page: 1, pageSize: 50, pages: 1 }),
    'GET /api/orgs/{orgSlug}/instances': () => ok({ items: [STACK], total: 1 }),
    'GET /api/instances/{instanceId}': byId('instanceId', stacks),
    'GET /api/v1/stacks/{idOrSlug}': byId('idOrSlug', {
      [STACK.slug]: { id: 101, slug: STACK.slug, name: STACK.name, url: STACK.url, region: REGION, orgSlug: ORG },
    }),
    'GET /api/instances/{instanceId}/plugins': () =>
      ok({ items: [{ pluginSlug: 'grafana-clock-panel', version: '2.1.5', instanceSlug: STACK.slug }] }),
    'GET /api/instances/{instanceId}/api/serviceaccounts/{serviceAccountId}': (req) =>
      stacks[req.params.instanceId ?? ''] && req.params.serviceAccountId === '5'
        ? ok({ id: 5, name: 'synoikia-bot', role: 'Viewer' })
        : notFound,
    'POST /api/instances/{instanceId}/api/serviceaccounts/{serviceAccountId}/tokens': () =>
      ok({ id: 9, name: 'ci', key: SECRETS.saToken }),
    'GET /api/v1/accesspolicies/{id}': regional({ [POLICY.id]: POLICY }),
    'GET /api/v1/tokens/{id}': regional({
      'tok-1': { id: 'tok-1', name: 'ci-token', accessPolicyId: POLICY.id, expiresAt: '2027-01-01T00:00:00Z' },
    }),
    'POST /api/v1/tokens': () =>
      ok({ id: 'tok-2', accessPolicyId: POLICY.id, name: 'new-token', token: SECRETS.cloudToken }),
    'GET /api/stack-regions': () =>
      ok({ items: [{ id: 1, slug: REGION, name: 'US East', provider: 'aws', status: 'active' }] }),
  };
  const paths = (JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> }).paths;
  for (const [template, item] of Object.entries(paths))
    for (const verb of Object.keys(item)) {
      const key = `${verb.toUpperCase()} /api${template}`;
      if (verb !== 'parameters' && !(key in routes)) routes[key] = () => ok();
    }

  const fake = await startFakeHttp({
    guard: (req) => {
      if (req.path.endsWith('/openapi.json')) return undefined;
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return { status: 401, body: { message: 'Unauthorized' } };
      return denied.has(req.path) ? { status: 403, body: { message: 'Forbidden' } } : undefined;
    },
    routes: Object.fromEntries(Object.entries(routes).sort(bySpecificity)),
  });
  return {
    ...fake,
    denied,
    serveSpec: (next) => {
      spec = next;
    },
  };
}
