import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeResponse, FakeRoute } from '@synoikia/core/testing';

/** A fake Grafana 12: the pinned v12.4.13 spec at /public/openapi3.json, Bearer auth on /api (but /health),
 * named resources for confirmation lookups, responses holding secrets, and `{ message }` for every other
 * operation in the spec. */

export const FAKE_TOKEN = 'glsa_fake-grafana-token-abcdef';
export const CREDENTIALS = { token: FAKE_TOKEN };
export const VERSION = '12.4.13';
export const ORG = 'Main Org.';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/grafana-openapi3.json', import.meta.url), 'utf8');

/** Secrets Grafana returns (a new token, a snapshot's delete key) or would if it stopped redacting them. */
export const SECRETS = {
  saToken: 'glsa_new-service-account-key-111111',
  deleteKey: 'snapshot-delete-key-222222',
  dsPassword: 'ds-basic-auth-password-333333',
  slackUrl: 'https://hooks.slack.com/services/T0000/B0000/slack-webhook-secret-444444',
  inviteCode: 'invite-code-161616',
};

export const DATASOURCE = {
  id: 5,
  uid: 'prom',
  name: 'Prometheus',
  type: 'prometheus',
  url: 'http://prometheus:9090',
  basicAuth: true,
  basicAuthUser: 'grafana',
  secureJsonData: { basicAuthPassword: SECRETS.dsPassword },
  secureJsonFields: { basicAuthPassword: true },
};

export interface FakeGrafana extends FakeHttp {
  /** Paths answered 403. */
  denied: Set<string>;
  /** The version /api/health reports; undefined hides it, as `anonymous.hide_version` does. */
  setVersion(version: string | undefined): void;
  /** Replaces what /public/openapi3.json serves (to test validation). */
  serveSpec(spec: unknown): void;
}

const ok = (body: unknown = { message: 'ok' }): FakeResponse => ({ body });
const byId =
  <T>(param: string, rows: Record<string, T>): FakeRoute =>
  (req) => {
    const row = rows[req.params[param] ?? ''];
    return row ? ok(row) : { status: 404, body: { message: 'not found' } };
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

export async function startFakeGrafana(): Promise<FakeGrafana> {
  let spec: unknown = JSON.parse(SPEC_TEXT);
  let version: string | undefined = VERSION;
  const denied = new Set<string>();

  const routes: Record<string, FakeRoute> = {
    'GET /public/openapi3.json': () => ok(spec),
    'GET /api/health': () => ok({ database: 'ok', ...(version ? { version, commit: 'abc123' } : {}) }),
    'GET /api/frontend/settings': () => ok({ buildInfo: { version: VERSION, edition: 'Open Source' } }),
    'GET /api/org': () => ok({ id: 1, name: ORG }),
    'GET /api/users/{user_id}': byId('user_id', { '2': { id: 2, login: 'alex', email: 'alex@example.com' } }),
    'GET /api/orgs/{org_id}': byId('org_id', { '2': { id: 2, name: 'Lab' } }),
    'GET /api/teams/{team_id}': byId('team_id', { '3': { id: 3, name: 'SRE' } }),
    'GET /api/access-control/roles/{roleUID}': byId('roleUID', {
      'custom-ops': { uid: 'custom-ops', name: 'custom:ops', displayName: 'Ops Reader' },
    }),
    'GET /api/serviceaccounts/{serviceAccountId}': byId('serviceAccountId', {
      '4': { id: 4, name: 'synoikia-bot', role: 'Viewer' },
    }),
    'POST /api/serviceaccounts/{serviceAccountId}/tokens': () => ok({ id: 11, name: 'ci', key: SECRETS.saToken }),
    'GET /api/datasources': () => ok([DATASOURCE]),
    'GET /api/datasources/{id}': byId('id', { '5': DATASOURCE }),
    'GET /api/datasources/uid/{uid}': byId('uid', { prom: DATASOURCE }),
    'GET /api/datasources/name/{name}': byId('name', { Prometheus: DATASOURCE }),
    'GET /api/folders/{folder_uid}': byId('folder_uid', { 'f-ops': { uid: 'f-ops', title: 'Ops' } }),
    'GET /api/dashboards/uid/{uid}': byId('uid', {
      'd-home': { dashboard: { uid: 'd-home', title: 'Home Lab', panels: [] }, meta: { folderUid: 'f-ops' } },
    }),
    'GET /api/search': () => ok([{ uid: 'd-home', title: 'Home Lab', type: 'dash-db', folderTitle: 'Ops' }]),
    'POST /api/ds/query': () => ok({ results: { A: { status: 200, frames: [] } } }),
    'GET /api/v1/provisioning/contact-points': () =>
      ok([
        {
          uid: 'cp-1',
          name: 'Ops Slack',
          type: 'slack',
          settings: { url: SECRETS.slackUrl, recipient: '#ops' },
          disableResolveMessage: false,
          provenance: '',
        },
      ]),
    'GET /api/org/invites': () =>
      ok([
        {
          email: 'pat@example.com',
          role: 'Editor',
          code: SECRETS.inviteCode,
          url: `http://grafana/invite/${SECRETS.inviteCode}`,
        },
      ]),
    'GET /api/v1/provisioning/alert-rules/{UID}': byId('UID', { 'r-1': { uid: 'r-1', title: 'High CPU' } }),
    'GET /api/library-elements/{library_element_uid}': byId('library_element_uid', {
      'le-1': { result: { uid: 'le-1', name: 'CPU panel' } },
    }),
    'GET /api/playlists/{uid}': byId('uid', { 'pl-1': { uid: 'pl-1', name: 'Wall' } }),
    'GET /api/reports/{id}': byId('id', { '7': { id: 7, name: 'Weekly' } }),
    'POST /api/snapshots': () =>
      ok({
        key: 'snapshot-view-key',
        url: 'http://grafana/dashboard/snapshot/snapshot-view-key',
        deleteKey: SECRETS.deleteKey,
        deleteUrl: `http://grafana/api/snapshots-delete/${SECRETS.deleteKey}`,
      }),
  };
  const paths = (JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> }).paths;
  for (const [template, item] of Object.entries(paths))
    for (const verb of Object.keys(item)) {
      const key = `${verb.toUpperCase()} /api${template.replace(/\/$/, '')}`;
      if (verb !== 'parameters' && !template.includes(':') && !(key in routes)) routes[key] = () => ok();
    }

  const fake = await startFakeHttp({
    guard: (req) => {
      if (req.path === '/api/health' || req.path === '/public/openapi3.json') return undefined;
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return { status: 401, body: { message: 'Unauthorized' } };
      return denied.has(req.path) ? { status: 403, body: { message: 'Forbidden' } } : undefined;
    },
    routes: Object.fromEntries(Object.entries(routes).sort(bySpecificity)),
  });
  return {
    ...fake,
    denied,
    setVersion: (next) => {
      version = next;
    },
    serveSpec: (next) => {
      spec = next;
    },
  };
}
