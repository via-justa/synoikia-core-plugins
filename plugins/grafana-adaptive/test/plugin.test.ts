import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { originOf } from '../src/connection.js';
import { createGrafanaAdaptivePlugin, settings } from '../src/plugin.js';
import { replaceText } from '../src/summary.js';
import { IDS, startFakeAdaptive, TOKEN } from './fake-adaptive.js';
import type { FakeAdaptive } from './fake-adaptive.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeAdaptive;
const plugin = createGrafanaAdaptivePlugin();
const context = { callId: 'unit', deadlineMs: 5000 };

const init = (config: Record<string, string>) =>
  plugin.init({ instanceId: 'adaptive', config, secrets: { token: TOKEN }, sdkVersion: '1.0.0' });

beforeAll(async () => {
  fake = await startFakeAdaptive();
});
beforeEach(async () => {
  fake.reset();
  await init(fake.connection());
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const resolve = (key: string, params?: unknown) =>
  plugin.resolveOperation({ fn: 'call', args: params === undefined ? [key] : [key, params] });
const run = async (key: string, params?: unknown) => {
  const r = await resolve(key, params);
  return plugin.invoke({ ...r, context });
};

describe('Grafana Adaptive plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: { instanceId: 'adaptive', config: fake.connection(), secrets: { token: TOKEN } },
      samples: [
        { fn: 'call', args: ['traces.policies.list'], expectKey: 'traces.policies.list' },
        {
          fn: 'call',
          args: ['traces.policies.delete', { path: { id: 'pol-1' } }],
          expectKey: 'traces.policies.delete',
        },
      ],
      rejects: [
        { fn: 'call', args: ['traces.nope'] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  describe('connection', () => {
    it('reports the configured services as the version, checking each one', async () => {
      await expect(plugin.testConnection()).resolves.toEqual({
        ok: true,
        upstreamVersion: 'adaptive (metrics, logs, traces)',
      });
      expect(fake.metrics.requests.at(-1)?.path).toBe('/aggregations/recommendations/config');
      expect(fake.logs.requests.at(-1)?.path).toBe('/adaptive-logs/exemptions');
      expect(fake.traces.requests.at(-1)?.path).toBe('/adaptive-traces/api/v1/policies');
    });

    it('offers only the operations of configured services', async () => {
      await init({ tempoUrl: fake.traces.url, tracesInstanceId: IDS.traces });
      const { operations, upstreamVersion } = await plugin.syncCatalog();
      expect(upstreamVersion).toBe('adaptive (traces)');
      expect(operations.every((o) => o.key.startsWith('traces.'))).toBe(true);
      await expect(resolve('metrics.rules.list')).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
    });

    it('needs a numeric instance id with each URL, and one service', async () => {
      await expect(init({ prometheusUrl: fake.metrics.url })).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
      await expect(init({ prometheusUrl: fake.metrics.url, metricsInstanceId: '12a' })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(init({})).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    });

    it('takes https, http only on loopback, and only the origin', () => {
      expect(originOf('https://prometheus-prod-01-eu-west-0.grafana.net/api/prom', 'u')).toBe(
        'https://prometheus-prod-01-eu-west-0.grafana.net',
      );
      expect(originOf('http://127.0.0.1:9090/tempo', 'u')).toBe('http://127.0.0.1:9090');
      expect(originOf('http://[::1]:9090', 'u')).toBe('http://[::1]:9090');
      for (const url of ['http://prometheus.example.com', 'http://127.0.0.1.example.com', 'ftp://x.example'])
        expect(() => originOf(url, 'u')).toThrow();
    });

    it('fails the test on a rejected token', async () => {
      await plugin.init({
        instanceId: 'adaptive',
        config: fake.connection(),
        secrets: { token: 'wrong' },
        sdkVersion: '1.0.0',
      });
      await expect(plugin.testConnection()).resolves.toMatchObject({ ok: false });
    });
  });

  describe('params', () => {
    it('refuses path params outside the template or of the wrong form', async () => {
      for (const [key, params] of [
        ['metrics.rules.get', { path: { metric: '../segments' } }],
        ['metrics.rules.get', { path: { metric: 'up', extra: 'x' } }],
        ['traces.policies.get', { path: { id: '..' } }],
        ['traces.policies.get', { path: { id: 'a/b' } }],
        ['logs.dropRules.get', {}],
      ] as const)
        await expect(resolve(key, params), JSON.stringify(params)).rejects.toMatchObject({
          code: ErrorCodes.InvalidParams,
        });
    });

    it('refuses undeclared, mistyped and case-duplicate query keys', async () => {
      for (const query of [{ verbose: 'yes' }, { action: ['drop'] }, { Verbose: true, verbose: true }, { other: 1 }])
        await expect(resolve('metrics.recommendations.list', { query })).rejects.toMatchObject({
          code: ErrorCodes.InvalidParams,
        });
      await expect(resolve('traces.policies.list', { query: { a: 'b' } })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(
        resolve('metrics.recommendations.list', { query: { action: ['add', 'update'] } }),
      ).resolves.toBeTruthy();
    });

    it('refuses Go-folded body keys and canonicalizes the ones it reads', async () => {
      await expect(
        resolve('traces.policies.create', { body: { name: 'a', Name: 'b', type: 't', body: {} } }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
      await expect(
        resolve('traces.policies.create', { body: { name: 'a', type: 't', body: {}, ['ſampling']: 1 } }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
      const r = await resolve('traces.policies.create', { body: { NAME: 'a', Type: 't', body: {} } });
      expect(r.params).toEqual({ body: { name: 'a', type: 't', body: {} } });
    });

    it('refuses a body, ifMatch or param where none is declared, and wrong field types', async () => {
      await expect(resolve('traces.policies.delete', { path: { id: 'pol-1' }, body: {} })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(resolve('logs.exemptions.list', { ifMatch: '"v1"' })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(resolve('logs.exemptions.list', { headers: {} })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(
        resolve('metrics.rules.replace', { ifMatch: '"v1"', body: [{ metric: 'a', drop: 'true' }] }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
      await expect(
        resolve('logs.dropRules.create', { body: { name: 'x', body: { drop_rate: '1', stream_selector: '{a="b"}' } } }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    });

    it('needs ifMatch on rules writes, and a matching metric', async () => {
      await expect(resolve('metrics.rules.replace', { body: [] })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(
        resolve('metrics.rules.delete', { path: { metric: 'up' }, ifMatch: 'a\r\nX: y' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(
        resolve('metrics.rules.create', { path: { metric: 'up' }, ifMatch: '"v1"', body: { metric: 'down' } }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    });
  });

  describe('invoke', () => {
    it('returns the rules with their etag, and recommendations with rulesVersion', async () => {
      await expect(run('metrics.rules.list')).resolves.toMatchObject({ etag: '"v1"', rules: fake.state.rules });
      await expect(run('metrics.recommendations.list')).resolves.toMatchObject({ rulesVersion: '"v1"' });
      const verbose = (await run('metrics.recommendations.list', { query: { verbose: true } })) as Record<
        string,
        unknown
      >;
      expect(verbose.rulesVersion).toBeUndefined();
    });

    it('sends If-Match and returns the new etag; a stale one says to re-read', async () => {
      await expect(
        run('metrics.rules.delete', { path: { metric: 'debug_events_total' }, ifMatch: '"v1"' }),
      ).resolves.toEqual({ ok: true, etag: '"v2"' });
      expect(fake.metrics.requests.at(-1)?.headers['if-match']).toBe('"v1"');
      await expect(run('metrics.rules.replace', { ifMatch: '"v1"', body: [] })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
        message: expect.stringContaining('metrics.rules.list'),
      });
      expect(fake.state.rules).toHaveLength(1);
    });

    it('returns rule check errors as data', async () => {
      await expect(run('metrics.rules.check', { body: [{ metric: 'ok_total' }] })).resolves.toEqual({
        valid: true,
        errors: [],
      });
      await expect(run('metrics.rules.check', { body: [{ metric: '9bad' }] })).resolves.toMatchObject({ valid: false });
    });

    it('sends each service to its own host with its own instance id', async () => {
      await run('logs.dropRules.list', { query: { expiration_filter: 'active' } });
      await run('traces.policies.get', { path: { id: 'pol-1' } });
      expect(fake.logs.requests.at(-1)).toMatchObject({ path: '/adaptive-logs/drop-rules' });
      expect(fake.traces.requests.at(-1)?.headers.authorization).toBe(
        `Basic ${Buffer.from(`${IDS.traces}:${TOKEN}`).toString('base64')}`,
      );
    });
  });

  describe('summaries', () => {
    it('lists drops before aggregations, removals and counts', () => {
      const text = replaceText(
        [
          { metric: 'a_total', drop_labels: ['pod'] },
          { metric: 'b_total', drop: true },
          { metric: 'c_total', drop: true },
        ],
        [{ metric: 'c_total', drop: true }, { metric: 'd_total' }],
      );
      expect(text).toBe(
        'drops entirely: "b_total"; aggregates: "a_total" aggregated (drop labels "pod"); removes the rules of "d_total" (kept in full again); 3 rules: 2 added, 0 changed, 1 removed, 1 unchanged',
      );
    });

    it('shows the match type of drops and removals, so a prefix drop never reads as one metric', () => {
      expect(
        replaceText(
          [
            { metric: 'go_', match_type: 'prefix', drop: true },
            { metric: '_bucket', match_type: 'suffix', drop: true },
            { metric: 'kube_pod_info', match_type: 'prefix', drop: true },
          ],
          [{ metric: 'kube_pod_info', drop: true }],
        ),
      ).toBe(
        'drops entirely: "go_" (prefix match), "_bucket" (suffix match), "kube_pod_info" (prefix match); removes the rules of "kube_pod_info" (kept in full again); 3 rules: 3 added, 0 changed, 1 removed, 0 unchanged',
      );
      expect(replaceText([{ metric: 'go_', match_type: 'prefix', drop: true }], undefined)).toContain(
        'drops entirely: "go_" (prefix match)',
      );
      expect(replaceText([{ metric: 'a', match_type: 'exact' }], [{ metric: 'a' }])).toContain('0 changed');
    });

    it('refuses a match type other than exact, prefix or suffix', async () => {
      for (const [key, params] of [
        ['metrics.rules.replace', { ifMatch: '"v1"', body: [{ metric: 'a', match_type: 'regex', drop: true }] }],
        ['metrics.rules.check', { body: [{ metric: 'a', match_type: '' }] }],
        ['metrics.exemptions.create', { body: { metric: 'a', match_type: 'Prefix' } }],
      ] as const)
        await expect(resolve(key, params)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    });

    it('lists the keep_labels a settings change removes', async () => {
      const r = await resolve('metrics.recommendations.updateConfig', { body: { keep_labels: ['team'] } });
      const s = await plugin.summarize({ ...r, targets: [] });
      expect(s.text).toContain('stops keeping labels "namespace"');
    });

    it('confirms a rule update or delete on the instance id when the stored rule cannot be read', async () => {
      for (const [key, params] of [
        ['metrics.rules.delete', { ifMatch: '"v1"', path: { metric: 'not_a_rule' } }],
        ['metrics.rules.update', { ifMatch: '"v1"', path: { metric: 'not_a_rule' }, body: { metric: 'not_a_rule' } }],
      ] as const) {
        const r = await resolve(key, params);
        const targets = (await plugin.resolveTargets?.(r)) ?? [];
        await expect(plugin.summarize({ ...r, targets })).resolves.toMatchObject({ confirmLiteral: IDS.metrics });
      }
    });

    it('ties an applied trace recommendation to its actions', async () => {
      const r = await resolve('traces.recommendations.apply', { path: { id: 'rec-1' } });
      const before = (await plugin.resolveTargets?.(r)) ?? [];
      (fake.state.traceRecommendations[0]!.actions as unknown[]).push({ action: 'remove', policy_id: 'pol-1' });
      const after = (await plugin.resolveTargets?.(r)) ?? [];
      expect(before.map((t) => t.kind)).toEqual(['instance', 'trace-recommendation']);
      expect(after[1]?.id).not.toBe(before[1]?.id);
    });

    it('takes the __global__ drop rule segment', async () => {
      await expect(run('logs.dropRules.list', { query: { segment_id: '__global__' } })).resolves.toBeTruthy();
    });

    it('says when the current rules cannot be read', () => {
      expect(replaceText([{ metric: 'x', drop: true }], undefined)).toBe(
        'drops entirely: "x"; the current rules could not be read; 1 rules sent replace them all',
      );
    });

    it('escapes bidi and control characters in names', async () => {
      const r = await resolve('traces.policies.create', { body: { type: 'probabilistic', name: 'a‮b\n', body: {} } });
      const s = await plugin.summarize({ ...r, targets: [] });
      expect(s.text).toContain('policy "a\\u202eb\\n"');
      expect(
        s.text.startsWith(`Adaptive Traces traces.policies.create on Adaptive Traces instance ${IDS.traces}:`),
      ).toBe(true);
    });

    it('confirms on the instance id when a stored object cannot be read', async () => {
      const r = await resolve('traces.policies.delete', { path: { id: 'missing' } });
      const targets = (await plugin.resolveTargets?.(r)) ?? [];
      expect(targets).toEqual([]);
      await expect(plugin.summarize({ ...r, targets })).resolves.toMatchObject({ confirmLiteral: IDS.traces });
    });
  });
});
