import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** Fake Adaptive Metrics, Logs and Traces, each on its own port as on a Grafana Cloud stack, each checking HTTP Basic
 * with its own instance id and the one access policy token. Shapes follow Grafana's clients (docs/designs). */

export const TOKEN = 'test-token-EXAMPLE';
export const IDS = { metrics: '100001', logs: '200002', traces: '300003' } as const;

type Obj = Record<string, unknown>;

export interface FakeAdaptive {
  metrics: FakeHttp;
  logs: FakeHttp;
  traces: FakeHttp;
  state: {
    rules: Obj[];
    etag: number;
    config: Obj;
    metricExemptions: Map<string, Obj>;
    dropRules: Map<string, Obj>;
    logExemptions: Map<string, Obj>;
    policies: Map<string, Obj>;
    traceRecommendations: Obj[];
  };
  /** Connection fields for all three services. */
  connection(): Record<string, string>;
  reset(): void;
  close(): Promise<void>;
}

const guardFor = (id: string) => (req: FakeRequest) =>
  req.headers.authorization === `Basic ${Buffer.from(`${id}:${TOKEN}`).toString('base64')}`
    ? undefined
    : { status: 401, body: { message: 'authentication error: invalid token' } };

const seed = (): FakeAdaptive['state'] => ({
  rules: [
    { metric: 'http_requests_total', drop_labels: ['pod', 'instance'], aggregations: ['sum', 'count'] },
    { metric: 'debug_events_total', drop: true },
  ],
  etag: 1,
  config: { keep_labels: ['namespace'], auto_apply: { enabled: false } },
  metricExemptions: new Map([['ex-1', { id: 'ex-1', metric: 'slo_errors_total', disable_recommendations: true }]]),
  dropRules: new Map([
    [
      'dr-1',
      {
        id: 'dr-1',
        segment_id: '__global__',
        version: 1,
        name: 'drop-debug',
        body: { drop_rate: 0.9, stream_selector: '{app="api"}', levels: ['debug'] },
      },
    ],
  ]),
  logExemptions: new Map([['lex-1', { id: 'lex-1', stream_selector: '{app="payments"}', reason: 'audit' }]]),
  policies: new Map([
    ['pol-1', { id: 'pol-1', type: 'probabilistic', name: 'keep-5-percent', body: { sampling_percentage: 5 } }],
  ]),
  traceRecommendations: [
    {
      id: 'rec-1',
      message: 'Sample health checks at 1%',
      applied: false,
      dismissed: false,
      actions: [
        {
          action: 'add',
          seed: { id: 's', type: 'probabilistic', name: 'health-checks', body: { sampling_percentage: 1 } },
        },
      ],
    },
  ],
});

export async function startFakeAdaptive(): Promise<FakeAdaptive> {
  let state = seed();
  let next = 1;
  const etag = () => `"v${state.etag}"`;
  const fresh = (): FakeResponse => {
    state.etag++;
    return { status: 200, headers: { etag: etag() } };
  };
  const stale = (req: FakeRequest): FakeResponse | undefined =>
    req.headers['if-match'] === etag() ? undefined : { status: 412, body: 'precondition failed: etag mismatch' };

  const metrics = await startFakeHttp({
    guard: guardFor(IDS.metrics),
    routes: {
      'GET /aggregations/rules': () => ({ body: state.rules, headers: { etag: etag() } }),
      'POST /aggregations/rules': (req) => {
        const refused = stale(req);
        if (refused) return refused;
        state.rules = req.body as Obj[];
        return fresh();
      },
      'GET /aggregations/rule/{metric}': (req) => {
        const rule = state.rules.find((r) => r.metric === req.params.metric);
        return rule ? { body: rule, headers: { etag: etag() } } : { status: 404, body: 'rule not found' };
      },
      'POST /aggregations/rule/{metric}': (req) => stale(req) ?? (state.rules.push(req.body as Obj), fresh()),
      'PUT /aggregations/rule/{metric}': (req) => {
        const refused = stale(req);
        if (refused) return refused;
        const i = state.rules.findIndex((r) => r.metric === req.params.metric);
        if (i < 0) return { status: 404, body: 'rule not found' };
        state.rules[i] = req.body as Obj;
        return fresh();
      },
      'DELETE /aggregations/rule/{metric}': (req) => {
        const refused = stale(req);
        if (refused) return refused;
        state.rules = state.rules.filter((r) => r.metric !== req.params.metric);
        return fresh();
      },
      'POST /aggregations/check-rules': (req) => {
        const bad = (req.body as Obj[]).filter((r) => !/^[a-z_:][a-z0-9_:]*$/i.test(String(r.metric)));
        return bad.length ? { status: 400, body: bad.map((r) => `invalid metric ${String(r.metric)}`) } : { body: [] };
      },
      'GET /aggregations/recommendations': (req) =>
        req.query.get('verbose') === 'true'
          ? {
              body: [
                {
                  metric: 'container_cpu_usage_seconds_total',
                  drop_labels: ['id'],
                  aggregations: ['sum'],
                  recommended_action: 'add',
                  usages_in_queries: 0,
                  total_series_before_aggregation: 5000,
                  total_series_after_aggregation: 40,
                },
              ],
            }
          : {
              body: [...state.rules, { metric: 'container_cpu_usage_seconds_total', drop_labels: ['id'] }],
              headers: { 'rules-version': etag() },
            },
      'GET /aggregations/recommendations/config': () => ({ body: state.config }),
      'POST /aggregations/recommendations/config': (req) => {
        state.config = req.body as Obj;
        return { status: 200 };
      },
      'GET /aggregations/rules/segments': () => ({ body: [{ id: 'seg-1', name: 'team-a', selector: '{team="a"}' }] }),
      'GET /v1/recommendations/exemptions': () => ({ body: { result: [...state.metricExemptions.values()] } }),
      'GET /v1/recommendations/exemptions/{id}': (req) => {
        const ex = state.metricExemptions.get(req.params.id!);
        return ex ? { body: { result: ex } } : { status: 404, body: 'not found' };
      },
      'POST /v1/recommendations/exemptions': (req) => {
        const ex = { ...(req.body as Obj), id: `ex-new-${next++}` };
        state.metricExemptions.set(ex.id, ex);
        return { body: { result: ex } };
      },
      'PUT /v1/recommendations/exemptions/{id}': (req) => {
        if (!state.metricExemptions.has(req.params.id!)) return { status: 404, body: 'not found' };
        state.metricExemptions.set(req.params.id!, { ...(req.body as Obj), id: req.params.id });
        return { status: 200 };
      },
      'DELETE /v1/recommendations/exemptions/{id}': (req) =>
        state.metricExemptions.delete(req.params.id!) ? { status: 200 } : { status: 404, body: 'not found' },
    },
  });

  const logs = await startFakeHttp({
    guard: guardFor(IDS.logs),
    routes: {
      'GET /adaptive-logs/recommendations': () => ({
        body: [
          {
            pattern: 'GET /health <_> 200',
            configured_drop_rate: 0.5,
            recommended_drop_rate: 0.95,
            volume: 123456,
            locked: false,
          },
        ],
      }),
      'GET /adaptive-logs/segments': () => ({ body: [{ id: 'lseg-1', name: 'prod', selector: '{env="prod"}' }] }),
      'GET /adaptive-logs/drop-rules': () => ({ body: [...state.dropRules.values()] }),
      'GET /adaptive-logs/drop-rules/{id}': (req) => {
        const r = state.dropRules.get(req.params.id!);
        return r ? { body: r } : { status: 404, body: 'not found' };
      },
      'POST /adaptive-logs/drop-rules': (req) => {
        const r = { segment_id: '__global__', version: 1, ...(req.body as Obj), id: `dr-new-${next++}` };
        state.dropRules.set(r.id, r);
        return { status: 201, body: r };
      },
      'PUT /adaptive-logs/drop-rules/{id}': (req) => {
        const old = state.dropRules.get(req.params.id!);
        if (!old) return { status: 404, body: 'not found' };
        const r = { ...old, ...(req.body as Obj) };
        state.dropRules.set(req.params.id!, r);
        return { body: r };
      },
      'DELETE /adaptive-logs/drop-rules/{id}': (req) =>
        state.dropRules.delete(req.params.id!) ? { status: 204 } : { status: 404, body: 'not found' },
      'GET /adaptive-logs/exemptions': () => ({ body: { result: [...state.logExemptions.values()] } }),
      'GET /adaptive-logs/exemptions/{id}': (req) => {
        const ex = state.logExemptions.get(req.params.id!);
        return ex ? { body: { result: ex } } : { status: 404, body: 'not found' };
      },
      'POST /adaptive-logs/exemptions': (req) => {
        const ex = { ...(req.body as Obj), id: `lex-new-${next++}` };
        state.logExemptions.set(ex.id, ex);
        return { body: { result: ex } };
      },
      'PUT /adaptive-logs/exemptions/{id}': (req) => {
        if (!state.logExemptions.has(req.params.id!)) return { status: 404, body: 'not found' };
        const ex = { ...(req.body as Obj), id: req.params.id };
        state.logExemptions.set(req.params.id!, ex);
        return { body: { result: ex } };
      },
      'DELETE /adaptive-logs/exemptions/{id}': (req) =>
        state.logExemptions.delete(req.params.id!) ? { status: 204 } : { status: 404, body: 'not found' },
    },
  });

  const traces = await startFakeHttp({
    guard: guardFor(IDS.traces),
    routes: {
      'GET /adaptive-traces/api/v1/policies': () => ({ body: [...state.policies.values()] }),
      'GET /adaptive-traces/api/v1/policies/{id}': (req) => {
        const p = state.policies.get(req.params.id!);
        return p ? { body: p } : { status: 404, body: 'not found' };
      },
      'POST /adaptive-traces/api/v1/policies': (req) => {
        const p = { ...(req.body as Obj), id: `pol-new-${next++}` };
        state.policies.set(p.id, p);
        return { status: 201, body: p };
      },
      'PUT /adaptive-traces/api/v1/policies/{id}': (req) => {
        if (!state.policies.has(req.params.id!)) return { status: 404, body: 'not found' };
        const p = { ...(req.body as Obj), id: req.params.id };
        state.policies.set(req.params.id!, p);
        return { body: p };
      },
      'DELETE /adaptive-traces/api/v1/policies/{id}': (req) =>
        state.policies.delete(req.params.id!) ? { status: 204 } : { status: 404, body: 'not found' },
      'GET /adaptive-traces/api/v1/recommendations': () => ({ body: state.traceRecommendations }),
      'POST /adaptive-traces/api/v1/recommendations/{id}/apply': (req) => {
        const rec = state.traceRecommendations.find((r) => r.id === req.params.id);
        if (!rec) return { status: 404, body: 'not found' };
        for (const a of rec.actions as Obj[]) {
          const seed = a.seed as Obj;
          const p = { ...seed, id: `pol-new-${next++}` };
          state.policies.set(p.id, p);
        }
        rec.applied = true;
        return { status: 204 };
      },
      'POST /adaptive-traces/api/v1/recommendations/{id}/dismiss': (req) => {
        const rec = state.traceRecommendations.find((r) => r.id === req.params.id);
        if (!rec) return { status: 404, body: 'not found' };
        rec.dismissed = true;
        return { status: 204 };
      },
    },
  });

  return {
    metrics,
    logs,
    traces,
    get state() {
      return state;
    },
    connection: () => ({
      prometheusUrl: `${metrics.url}/api/prom`,
      metricsInstanceId: IDS.metrics,
      lokiUrl: logs.url,
      logsInstanceId: IDS.logs,
      tempoUrl: `${traces.url}/tempo`,
      tracesInstanceId: IDS.traces,
    }),
    reset() {
      state = seed();
      next = 1;
      for (const f of [metrics, logs, traces]) f.requests.length = 0;
    },
    async close() {
      await Promise.all([metrics.close(), logs.close(), traces.close()]);
    },
  };
}
