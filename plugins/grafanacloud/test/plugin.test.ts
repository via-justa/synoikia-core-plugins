import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, cloudLookup, createGrafanaCloudPlugin, settings } from '../src/plugin.js';
import { loadSpec } from '../src/spec.js';
import { CREDENTIALS, ORG, REGION, SPEC_TEXT, startFakeGrafanaCloud, VERSION } from './fake-grafanacloud.js';
import type { FakeGrafanaCloud } from './fake-grafanacloud.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeGrafanaCloud;
const plugin = createGrafanaCloudPlugin();

beforeAll(async () => {
  fake = await startFakeGrafanaCloud();
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const config = () => ({ org: ORG, apiUrl: `${fake.url}/api`, specUrl: `${fake.url}/api/openapi.json` });
const connection = () => ({ instanceId: 'grafanacloud', config: config(), secrets: { ...CREDENTIALS } });
const specOf = () => JSON.parse(SPEC_TEXT) as { paths: Record<string, Record<string, unknown>> };
const load = (urls: string[]) =>
  loadSpec(urls, (spec) => buildCatalog(spec), { service: 'Grafana Cloud', maxBytes: 5_000_000, timeoutMs: 5000 });

describe('Grafana Cloud plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/instances', query: { pageSize: 10 } }], expectKey: 'GET /instances' },
        {
          fn: 'request',
          args: [{ method: 'DELETE', path: '/v1/stacks/acme-prod' }],
          expectKey: 'DELETE /v1/stacks/{idOrSlug}',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/orgs/acme/check-visibility' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the spec and reports its version and the host it came from', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { upstreamVersion, sourceRef, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe(VERSION);
    expect(sourceRef).toBe(new URL(fake.url).host);
    expect(operations).toHaveLength(54);
    const spec = fake.requests.find((r) => r.path === '/api/openapi.json');
    expect(spec?.headers.authorization).toBeUndefined();
  });

  it('fetches the spec from grafana.com, then from the GitHub copy, unless the connection names a source', () => {
    expect(settings.plugin.apiUrl).toBe('https://grafana.com/api');
    expect(settings.plugin.spec.urls).toEqual([
      'https://grafana.com/api/openapi.json',
      'https://raw.githubusercontent.com/grafana/grafana-com-public-clients/main/openapi.json',
    ]);
  });

  it('falls back to the next spec source on a failed download, a non-JSON body or an unusable spec', async () => {
    const pinned = `${fake.url}/pinned/openapi.json`;
    for (const first of ['/broken/openapi.json', '/html/openapi.json'])
      await expect(load([`${fake.url}${first}`, pinned])).resolves.toMatchObject({ version: VERSION });
    const spec = specOf();
    const { post: _gone, ...rest } = spec.paths['/v1/tokens/{id}']!;
    fake.serveSpec({ ...spec, paths: { ...spec.paths, '/v1/tokens/{id}': rest } });
    const loaded = await load([`${fake.url}/api/openapi.json`, pinned]);
    expect(loaded.catalog.operations.some((o) => o.key === 'POST /v1/tokens/{id}')).toBe(true);
    fake.serveSpec(spec);
  });

  it('names every failed source when none serves a usable spec', async () => {
    const error = await load([`${fake.url}/broken/openapi.json`, `${fake.url}/html/openapi.json`]).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ code: ErrorCodes.UpstreamError });
    expect(String((error as Error).message)).toMatch(/HTTP 503.*not JSON/);
  });

  it('refuses a sync when the only spec source lost a locked operation', async () => {
    const spec = specOf();
    const { post: _gone, ...rest } = spec.paths['/v1/accesspolicies']!;
    fake.serveSpec({ ...spec, paths: { ...spec.paths, '/v1/accesspolicies': rest } });
    await expect(plugin.syncCatalog()).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringContaining('POST /v1/accesspolicies'),
    });
    fake.serveSpec(spec);
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: VERSION });
  });

  it('tests the connection by reading the org, and reports a wrong token or org', async () => {
    await expect(plugin.testConnection()).resolves.toEqual({ ok: true, upstreamVersion: VERSION });
    expect(fake.requests.some((r) => r.path === `/api/orgs/${ORG}`)).toBe(true);
    for (const [cfg, secrets] of [
      [config(), { token: 'wrong' }],
      [{ ...config(), org: 'someone-else' }, CREDENTIALS],
    ] as const) {
      const other = createGrafanaCloudPlugin();
      await other.init({ instanceId: 'x', config: cfg, secrets, sdkVersion: '1' });
      expect(await other.testConnection()).toMatchObject({ ok: false });
      await other.shutdown?.();
    }
  });

  it('refuses a bad org slug and non-https URL overrides', async () => {
    for (const cfg of [
      { org: '' },
      { org: 'Acme Corp' },
      { org: ORG, apiUrl: 'http://grafana.example.net/api' },
      { org: ORG, apiUrl: 'not a url' },
      { org: ORG, specUrl: 'http://mirror.example.net/openapi.json' },
    ])
      await expect(
        createGrafanaCloudPlugin().init({ ...connection(), config: cfg, sdkVersion: '1' }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    const ok = createGrafanaCloudPlugin();
    await expect(
      ok.init({
        ...connection(),
        config: { org: ORG, specUrl: 'https://mirror.example.net/openapi.json' },
        sdkVersion: '1',
      }),
    ).resolves.toBeUndefined();
    await ok.shutdown?.();
  });

  it('resolves paths with or without the /api prefix', async () => {
    for (const path of ['/instances/acme-prod', '/api/instances/acme-prod'])
      await expect(plugin.resolveOperation({ fn: 'request', args: [{ path }] })).resolves.toEqual({
        key: 'GET /instances/{instanceId}',
        params: { path: { instanceId: 'acme-prod' } },
      });
  });

  it('refuses keys Go would bind to the same field: case variants at any depth, and non-ASCII keys', async () => {
    const resolve = (path: string, body: unknown, query: Record<string, unknown> = { region: REGION }) =>
      plugin.resolveOperation({ fn: 'request', args: [{ method: 'POST', path, query, body }] });
    for (const [path, body] of [
      ['/v1/tokens', { name: 'ci', accessPolicyId: 'ap-1', AccessPolicyId: 'admin-policy' }],
      ['/v1/accesspolicies', { name: 'r', scopes: ['metrics:read'], Scopes: ['accesspolicies:write'], realms: [] }],
      ['/v1/accesspolicies', { name: 'r', scopes: ['metrics:read'], ſcopes: ['accesspolicies:write'] }],
      ['/v1/accesspolicies', { name: 'r', scopes: [], realms: [{ type: 'stack', Type: 'org', identifier: '1' }] }],
      ['/v1/stacks', { slug: 'a', Slug: 'b', name: 'n', region: REGION, org: ORG }],
      ['/instances/acme-prod/api/serviceaccounts', { name: 'ci', role: 'Viewer', ROLE: 'Admin' }],
      ['/orgs/acme/settings', { mfaRequired: true, ['mfaKequired']: false }],
    ] as const)
      await expect(resolve(path, body), JSON.stringify(body)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(
      resolve('/v1/tokens', { name: 'ci', accessPolicyId: 'ap-1' }, { region: REGION, Region: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });

  it('renames a lone case variant to the spelling approvals read', async () => {
    const { key, params } = await plugin.resolveOperation({
      fn: 'request',
      args: [
        { method: 'POST', path: '/v1/tokens', query: { Region: REGION }, body: { NAME: 'ci', AccessPolicyID: 'ap-1' } },
      ],
    });
    expect(params).toEqual({ query: { region: REGION }, body: { name: 'ci', accessPolicyId: 'ap-1' } });
    const targets = await plugin.resolveTargets!({ key, params });
    await expect(plugin.summarize({ key, params, targets })).resolves.toMatchObject({
      confirmLiteral: 'stack-readers',
      text: expect.stringContaining('[accessPolicyId="ap-1", name="ci"]'),
    });
  });

  it('looks up regional records with the call region, and allows only GETs', async () => {
    const lookup = cloudLookup(() => {
      throw new Error('no client');
    });
    await expect(lookup('POST /v1/tokens', [], 1000)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    const summary = (key: string, params: unknown) => plugin.summarize({ key, params, targets: [] });
    await expect(
      summary('DELETE /v1/accesspolicies/{id}', { path: { id: 'ap-1' }, query: { region: REGION } }),
    ).resolves.toMatchObject({ confirmLiteral: 'stack-readers' });
    await expect(summary('DELETE /v1/accesspolicies/{id}', { path: { id: 'ap-1' } })).resolves.toMatchObject({
      confirmLiteral: 'ap-1',
    });
  });

  it('takes the literal from the stored record, not the body, and falls back to the id', async () => {
    const summary = (key: string, path: Record<string, string>, body?: unknown) =>
      plugin.summarize({ key, params: { path, body }, targets: [] });
    await expect(
      summary('POST /v1/stacks/{idOrSlug}', { idOrSlug: '101x' }, { slug: 'mallory' }),
    ).resolves.toMatchObject({ confirmLiteral: '101x' });
    await expect(
      summary('POST /instances/{instanceId}', { instanceId: '101' }, { slug: 'mallory' }),
    ).resolves.toMatchObject({ confirmLiteral: 'acme-prod' });
    await expect(summary('DELETE /instances/{instanceId}', { instanceId: 'gone' })).resolves.toMatchObject({
      confirmLiteral: 'gone',
    });
    await expect(summary('POST /orgs/{slugOrId}/members', { slugOrId: '7' }, { username: 'x' })).resolves.toMatchObject(
      {
        confirmLiteral: ORG,
      },
    );
  });

  it("confirms a delete a newer spec adds against the connection's org", async () => {
    const spec = specOf();
    fake.serveSpec({ ...spec, paths: { ...spec.paths, '/v1/stacks/{idOrSlug}/labels': { delete: { summary: 'x' } } } });
    const { operations } = await plugin.syncCatalog();
    expect(operations.find((o) => o.key === 'DELETE /v1/stacks/{idOrSlug}/labels')).toMatchObject({ locked: true });
    await expect(
      plugin.summarize({
        key: 'DELETE /v1/stacks/{idOrSlug}/labels',
        params: { path: { idOrSlug: 'acme-prod' } },
        targets: [],
      }),
    ).resolves.toMatchObject({ confirmLiteral: ORG });
    fake.serveSpec(spec);
    await plugin.syncCatalog();
  });

  it('names the stack, the access policy with its privileges, or the token a call acts on', async () => {
    const targets = (key: string, params: unknown) => plugin.resolveTargets!({ key, params });
    const stack = {
      kind: 'stack',
      name: 'acme-prod (Acme Production, https://acme-prod.grafana.net, region prod-us-east-0)',
    };
    const policy = {
      kind: 'accesspolicy',
      id: 'ap-1',
      name: 'stack-readers (scopes: metrics:read, logs:read; realms: stack 101 {env="prod"})',
    };
    await expect(targets('DELETE /instances/{instanceId}', { path: { instanceId: 'acme-prod' } })).resolves.toEqual([
      { ...stack, id: 'acme-prod' },
    ]);
    await expect(
      targets('POST /instances/{instanceId}/plugins', { path: { instanceId: '101' }, body: { plugin: 'x' } }),
    ).resolves.toEqual([{ ...stack, id: '101' }]);
    await expect(targets('DELETE /v1/stacks/{idOrSlug}', { path: { idOrSlug: 'acme-prod' } })).resolves.toEqual([
      { ...stack, id: 'acme-prod' },
    ]);
    await expect(
      targets('POST /v1/tokens', { query: { region: REGION }, body: { name: 'ci', accessPolicyId: 'ap-1' } }),
    ).resolves.toEqual([policy]);
    await expect(
      targets('POST /v1/accesspolicies/{id}', { path: { id: 'ap-1' }, query: { region: REGION } }),
    ).resolves.toEqual([policy]);
    await expect(targets('POST /v1/accesspolicies/{id}', { path: { id: 'ap-1' } })).resolves.toEqual([
      { kind: 'accesspolicy', id: 'ap-1', name: 'ap-1' },
    ]);
    await expect(
      targets('DELETE /v1/tokens/{id}', { path: { id: 'tok-1' }, query: { region: REGION } }),
    ).resolves.toEqual([
      { kind: 'token', id: 'tok-1', name: 'ci-token (access policy ap-1, expires 2027-01-01T00:00:00Z)' },
    ]);
    await expect(targets('GET /instances/{instanceId}', { path: { instanceId: 'acme-prod' } })).resolves.toEqual([]);
    await expect(targets('DELETE /instances/{instanceId}', { path: { instanceId: 'gone' } })).resolves.toEqual([]);
  });

  it('shows privileges and destinations ahead of a padded body, model-written text escaped', async () => {
    const body = {
      padding: 'x'.repeat(5000),
      name: 'evil\u202egnp.exe',
      realms: [{ type: 'org', identifier: '7' }],
      scopes: ['accesspolicies:write'],
    };
    const { text } = await plugin.summarize({
      key: 'POST /v1/accesspolicies',
      params: { query: { region: REGION }, body },
      targets: [],
    });
    expect(text).toMatch(
      /^Grafana Cloud POST \/v1\/accesspolicies\?region=prod-us-east-0 \[realms=\[\{"type":"org","identifier":"7"\}\], scopes=\["accesspolicies:write"\], name="evil\\u202egnp\.exe"\] \{/,
    );
    expect(text).not.toContain('\u202e');
    const del = await plugin.summarize({
      key: 'DELETE /v1/stacks/{idOrSlug}',
      params: { path: { idOrSlug: 'acme-prod' } },
      targets: [],
    });
    expect(del.text).toBe(
      'Grafana Cloud DELETE /v1/stacks/acme-prod (deletes the stack with all its dashboards, metrics, logs and traces; this cannot be undone)',
    );
  });
});
