import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrafanaPlugin, settings } from '../src/plugin.js';
import { CREDENTIALS, ORG, SPEC_TEXT, startFakeGrafana, VERSION } from './fake-grafana.js';
import type { FakeGrafana } from './fake-grafana.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeGrafana;
const plugin = createGrafanaPlugin();

beforeAll(async () => {
  fake = await startFakeGrafana();
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const connection = () => ({ instanceId: 'grafana', config: { baseUrl: fake.url }, secrets: { ...CREDENTIALS } });

describe('Grafana plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/search', query: { query: 'home' } }], expectKey: 'GET /search' },
        {
          fn: 'request',
          args: [{ method: 'DELETE', path: '/datasources/uid/prom' }],
          expectKey: 'DELETE /datasources/uid/{uid}',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/datasources/proxy/uid/prom/api/v1/query' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the spec served outside /api and reports the version from /api/health', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { upstreamVersion, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe(VERSION);
    expect(operations).toHaveLength(310);
    expect(fake.requests.some((r) => r.path === '/public/openapi3.json')).toBe(true);
  });

  it('reads the version from the frontend settings when /api/health hides it', async () => {
    fake.setVersion(undefined);
    await expect(plugin.getUpstreamVersion()).resolves.toBe(VERSION);
    fake.setVersion(VERSION);
  });

  it('refuses Grafana 11 and older with a clear message', async () => {
    for (const old of ['11.6.0', '10.4.2']) {
      fake.setVersion(old);
      await expect(plugin.testConnection()).resolves.toEqual({
        ok: false,
        message: `Grafana ${old} is not supported; this plugin needs Grafana 12 or later`,
      });
      await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    }
    fake.setVersion('12.0.0-security-01');
    await expect(plugin.testConnection()).resolves.toMatchObject({ ok: true });
    fake.setVersion(VERSION);
  });

  it('resolves paths with or without the /api prefix, and refuses proxies', async () => {
    for (const path of ['/dashboards/uid/d-home', '/api/dashboards/uid/d-home'])
      await expect(plugin.resolveOperation({ fn: 'request', args: [{ path }] })).resolves.toEqual({
        key: 'GET /dashboards/uid/{uid}',
        params: { path: { uid: 'd-home' } },
      });
    for (const path of ['/datasources/proxy/5/api/v1/query', '/datasources/uid/prom/resources/labels'])
      await expect(plugin.resolveOperation({ fn: 'request', args: [{ path }] })).rejects.toMatchObject({
        code: ErrorCodes.UnknownOperation,
      });
  });

  it('takes the literal from the stored record, not the body, and falls back to the id', async () => {
    const summary = (key: string, path: Record<string, string>, body?: unknown) =>
      plugin.summarize({ key, params: { path, body }, targets: [] });
    await expect(summary('PUT /users/{user_id}', { user_id: '2' }, { login: 'mallory' })).resolves.toMatchObject({
      confirmLiteral: 'alex',
    });
    await expect(summary('DELETE /teams/{team_id}', { team_id: '404' })).resolves.toMatchObject({
      confirmLiteral: '404',
    });
    await expect(summary('PUT /v1/provisioning/contact-points/{UID}', { UID: 'cp-1' })).resolves.toMatchObject({
      confirmLiteral: 'Ops Slack',
    });
    await expect(summary('POST /datasources', {}, { name: 'Loki' })).resolves.toMatchObject({ confirmLiteral: ORG });
  });

  it('names the stored data source with its type and URL as the target of non-GET calls', async () => {
    const targets = (key: string, path: Record<string, string>) => plugin.resolveTargets!({ key, params: { path } });
    const prom = { kind: 'datasource', name: 'Prometheus (prometheus, http://prometheus:9090)' };
    await expect(targets('PUT /datasources/uid/{uid}', { uid: 'prom' })).resolves.toEqual([{ ...prom, id: 'prom' }]);
    await expect(targets('DELETE /datasources/{id}', { id: '5' })).resolves.toEqual([{ ...prom, id: '5' }]);
    await expect(targets('GET /datasources/uid/{uid}', { uid: 'prom' })).resolves.toEqual([]);
    await expect(targets('PUT /datasources/uid/{uid}', { uid: 'nope' })).resolves.toEqual([]);
    await expect(targets('DELETE /folders/{folder_uid}', { folder_uid: 'f-ops' })).resolves.toEqual([]);
  });

  it('names every data source a query hits, and refuses a query naming too many', async () => {
    const targets = (queries: unknown[]) =>
      plugin.resolveTargets!({ key: 'POST /ds/query', params: { body: { queries } } });
    await expect(
      targets([{ datasource: { uid: 'prom' } }, { datasource: { uid: 'prom' } }, { datasource: { uid: 'gone' } }, {}]),
    ).resolves.toEqual([
      { kind: 'datasource', id: 'prom', name: 'Prometheus (prometheus, http://prometheus:9090)' },
      { kind: 'datasource', id: 'gone', name: 'gone' },
    ]);
    const many = Array.from({ length: 21 }, (_, i) => ({ datasource: { uid: `ds-${i}` } }));
    await expect(targets(many)).rejects.toMatchObject({ code: ErrorCodes.TargetResolutionFailed });
  });

  it('names a data source given by datasourceId or name with its stored uid, and refuses one it cannot read', async () => {
    const prom = { kind: 'datasource', id: 'prom', name: 'Prometheus (prometheus, http://prometheus:9090)' };
    const padding = 'x'.repeat(1500);
    for (const q of [{ datasourceId: 5 }, { datasourceId: '5' }, { datasource: 'Prometheus' }, { DatasourceID: 5 }]) {
      const call = await plugin.resolveOperation({
        fn: 'request',
        args: [{ method: 'POST', path: '/ds/query', body: { padding, queries: [{ refId: 'A', padding, ...q }] } }],
      });
      const targets = await plugin.resolveTargets!(call);
      expect(targets, JSON.stringify(q)).toEqual([prom]);
      const { text } = await plugin.summarize({ ...call, targets });
      expect(text).toContain(`on ${prom.name}`);
    }
    const targets = (queries: unknown[]) =>
      plugin.resolveTargets!({ key: 'POST /ds/query', params: { body: { queries } } });
    await expect(targets([{ datasource: { uid: 'prom' } }, { datasourceId: 5 }])).resolves.toEqual([prom]);
    for (const q of [{ datasourceId: 99 }, { datasource: 'Unknown' }, { datasource: 7 }, { datasourceId: { id: 5 } }])
      await expect(targets([q]), JSON.stringify(q)).rejects.toMatchObject({ code: ErrorCodes.TargetResolutionFailed });
  });

  it("names only a contact point URL's host as its destination", async () => {
    const targets = (url: unknown) =>
      plugin.resolveTargets!({ key: 'POST /v1/provisioning/contact-points', params: { body: { settings: { url } } } });
    await expect(targets('https://hooks.slack.com/services/T0/B0/secret')).resolves.toEqual([
      { kind: 'destination', id: 'hooks.slack.com', name: 'hooks.slack.com (contact point URL)' },
    ]);
    await expect(targets('not a url <b>')).resolves.toEqual([
      { kind: 'destination', id: 'an invalid URL', name: 'an invalid URL (contact point URL)' },
    ]);
    await expect(targets(undefined)).resolves.toEqual([]);
  });

  it('escapes bidi and zero-width characters, and lists each address ahead of a padded one', async () => {
    const addresses = `${' '.repeat(300)}${'x'.repeat(500)}@pad.example;\n evil\u202emoc.example ,ops\u200b@example.net`;
    const body = { name: 'Mail', url: 'http://loki.example.net\u2066:3100', settings: { addresses } };
    const { text } = await plugin.summarize({ key: 'POST /datasources', params: { body }, targets: [] });
    expect(text).toContain(
      `[to url=an invalid URL "http://loki.example.net\\u2066:3100", settings/addresses=["${'x'.repeat(200)}…", "evil\\u202emoc.example", "ops\\u200b@example.net"]] {`,
    );
    expect(text).not.toMatch(/[\u200b\u202e\u2066]/);
    const many = Array.from({ length: 25 }, (_, i) => `a${i}@example.net`);
    const listed = await plugin.summarize({
      key: 'POST /datasources',
      params: { body: { emails: many } },
      targets: [],
    });
    expect(listed.text).toContain('"a19@example.net" and 5 more]');
    const targets = await plugin.resolveTargets!({
      key: 'POST /ds/query',
      params: { body: { queries: [{ datasource: { uid: 'gone\u202e' } }] } },
    });
    expect(targets).toEqual([{ kind: 'datasource', id: 'gone\u202e', name: 'gone\\u202e' }]);
  });

  it('shows a URL destination by the host Go resolves, ahead of comma or userinfo padding', async () => {
    const summarize = (url: string) =>
      plugin.summarize({ key: 'POST /datasources', params: { body: { name: 'P', url } }, targets: [] });
    const commas = await summarize(`http://prom.internal${',x'.repeat(25)}@evil.example:9090`);
    expect(commas.text).toMatch(/^Grafana POST \/datasources \[to url=evil\.example:9090 "http:\/\/prom\.internal,x,/);
    const userinfo = await summarize(`http://${'u'.repeat(300)}@evil.example/`);
    expect(userinfo.text).toMatch(/^Grafana POST \/datasources \[to url=evil\.example "http:\/\/u+…"/);
  });

  it('shows destination fields ahead of a padded body', async () => {
    const body = { padding: 'x'.repeat(5000), url: 'http://loki.example.net:3100', recipients: 'a@example.net' };
    const { text } = await plugin.summarize({ key: 'POST /datasources', params: { body }, targets: [] });
    expect(text).toMatch(
      /^Grafana POST \/datasources \[to url=loki\.example\.net:3100 "http:\/\/loki\.example\.net:3100", recipients="a@example\.net"\] \{/,
    );
    const report = await plugin.summarize({
      key: 'PUT /reports/{id}',
      params: { path: { id: '7' }, body },
      targets: [],
    });
    expect(report.text).toContain(
      'Grafana PUT /reports/7 [to url=loki.example.net:3100 "http://loki.example.net:3100", recipients="a@example.net"]',
    );
  });

  it('refuses keys Go would bind to the same field: case variants at any depth, and non-ASCII keys', async () => {
    const resolve = (method: string, path: string, body: unknown, query?: Record<string, unknown>) =>
      plugin.resolveOperation({ fn: 'request', args: [{ method, path, query, body }] });
    for (const [method, path, body] of [
      ['POST', '/ds/query', { queries: [{ datasource: { uid: 'prom' }, Datasource: { uid: 'mysql-prod' } }] }],
      ['POST', '/ds/query', { queries: [{ datasource: { uid: 'prom', UID: 'mysql-prod' } }] }],
      ['POST', '/datasources', { name: 'loki', url: 'http://loki:3100', URL: 'http://evil.example.net' }],
      ['PUT', '/datasources/uid/prom', { name: 'p', url: 'http://prometheus:9090', Url: 'http://evil.example.net' }],
      ['POST', '/v1/provisioning/contact-points', { settings: { url: 'https://a.example' }, ſettings: {} }],
      ['PUT', '/reports/7', { recipients: 'a@example.net', recipientſ: 'x@evil.example.net' }],
      ['POST', '/licensing/token', { token: 'a', ['toKen']: 'b' }],
      ['POST', '/ds/query', { queries: [{ datasourceId: 5, DatasourceId: 9 }] }],
      ['POST', '/ds/query', { queries: [{ datasource: { uid: 'prom' }, model: { Expr: 'a', expr: 'b' } }] }],
      ['POST', '/datasources', { name: 'p', secureJsonData: {}, SecureJsonData: { password: 'x' } }],
    ] as const)
      await expect(resolve(method, path, body), JSON.stringify(body)).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
    await expect(resolve('GET', '/search', undefined, { query: 'a', Query: 'b' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });

  it('passes free-form maps the plugin never reads as sent', async () => {
    for (const [path, body] of [
      ['/dashboards/db', { dashboard: { panels: [{ aliasColors: { CPU: 'red', cpu: 'blue', Température: 'x' } }] } }],
      ['/datasources', { name: 'p', url: 'http://p:9090', jsonData: { Header: 'a', header: 'b' } }],
    ] as const) {
      const { params } = await plugin.resolveOperation({ fn: 'request', args: [{ method: 'POST', path, body }] });
      expect(params).toEqual({ body });
    }
  });

  it('renames a lone case variant to the spelling targets and summaries read', async () => {
    const query = await plugin.resolveOperation({
      fn: 'request',
      args: [{ method: 'POST', path: '/ds/query', body: { Queries: [{ DataSource: { UID: 'prom' }, expr: 'up' }] } }],
    });
    expect(query.params).toEqual({ body: { queries: [{ datasource: { uid: 'prom' }, expr: 'up' }] } });
    await expect(plugin.resolveTargets!(query)).resolves.toEqual([
      { kind: 'datasource', id: 'prom', name: 'Prometheus (prometheus, http://prometheus:9090)' },
    ]);
    const ds = await plugin.resolveOperation({
      fn: 'request',
      args: [{ method: 'POST', path: '/datasources', body: { name: 'loki', URL: 'http://loki.example.net:3100' } }],
    });
    expect(ds.params).toEqual({ body: { name: 'loki', url: 'http://loki.example.net:3100' } });
    const cp = await plugin.resolveOperation({
      fn: 'request',
      args: [{ method: 'POST', path: '/v1/provisioning/contact-points', body: { Settings: { URL: 'https://a.b/c' } } }],
    });
    expect(cp.params).toEqual({ body: { settings: { url: 'https://a.b/c' } } });
    await expect(plugin.summarize({ ...ds, targets: [] })).resolves.toMatchObject({
      text: expect.stringContaining('[to url=loki.example.net:3100 "http://loki.example.net:3100"]'),
    });
  });

  it('reports a rejected token without throwing', async () => {
    const bad = createGrafanaPlugin();
    await bad.init({ ...connection(), secrets: { token: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });

  it('refuses a served spec that is not an OpenAPI document, a truncated one, or one missing a lock', async () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    const { '/admin/settings': _settings, ...withoutSettings } = spec.paths;
    for (const bad of [
      { message: 'Not found' },
      { openapi: '3.0.3', paths: { '/health': { get: {} } } },
      { ...spec, paths: withoutSettings },
    ]) {
      fake.serveSpec(bad);
      await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    }
    fake.serveSpec(spec);
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: VERSION });
  });

  it('refuses a connection without a base URL', async () => {
    await expect(createGrafanaPlugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});
