import { IDS } from './fake-adaptive.js';
import type { FakeAdaptive } from './fake-adaptive.js';

/** One call per locked key against the freshly seeded fake (rules etag `"v1"`), the literal an approver types, the
 * text the approval must show first, and the change it makes upstream. */
export interface LockCase {
  key: string;
  params: Record<string, unknown>;
  confirm: string;
  shows: string;
  done(state: FakeAdaptive['state']): boolean;
}

const ETAG = '"v1"';

export const LOCK_CASES: LockCase[] = [
  {
    key: 'metrics.rules.replace',
    params: {
      ifMatch: ETAG,
      body: [
        { metric: 'http_requests_total', drop_labels: ['pod'], aggregations: ['sum'] },
        { metric: 'go_gc_duration_seconds', drop: true },
      ],
    },
    confirm: IDS.metrics,
    shows: `on Adaptive Metrics instance ${IDS.metrics}: drops entirely: "go_gc_duration_seconds"; aggregates: "http_requests_total" aggregated (drop labels "pod"; aggregations "sum"); removes the rules of "debug_events_total"`,
    done: (s) => s.rules.length === 2 && s.rules.some((r) => r.metric === 'go_gc_duration_seconds'),
  },
  {
    key: 'metrics.rules.create',
    params: {
      ifMatch: ETAG,
      path: { metric: 'kube_pod_info' },
      body: { metric: 'kube_pod_info', drop_labels: ['uid‮'] },
    },
    confirm: 'kube_pod_info',
    shows: `on Adaptive Metrics instance ${IDS.metrics}: "kube_pod_info" aggregated (drop labels "uid\\u202e")`,
    done: (s) => s.rules.some((r) => r.metric === 'kube_pod_info'),
  },
  {
    key: 'metrics.rules.update',
    params: {
      ifMatch: ETAG,
      path: { metric: 'http_requests_total' },
      body: { metric: 'http_requests_total', drop: true },
    },
    confirm: 'http_requests_total',
    shows: 'on http_requests_total: "http_requests_total" dropped entirely',
    done: (s) => s.rules.find((r) => r.metric === 'http_requests_total')?.drop === true,
  },
  {
    key: 'metrics.rules.delete',
    params: { ifMatch: ETAG, path: { metric: 'debug_events_total' } },
    confirm: 'debug_events_total',
    shows:
      'on debug_events_total: removes the rule of "debug_events_total" (now "debug_events_total" dropped entirely)',
    done: (s) => !s.rules.some((r) => r.metric === 'debug_events_total'),
  },
  {
    key: 'metrics.recommendations.updateConfig',
    params: { body: { keep_labels: [], auto_apply: { enabled: true, gate: { policy: 'unbounded' } } } },
    confirm: IDS.metrics,
    shows: `on Adaptive Metrics instance ${IDS.metrics}: auto-apply ON: recommendations change the rules without review (gate "unbounded")`,
    done: (s) => (s.config.auto_apply as { enabled?: boolean }).enabled === true,
  },
  {
    key: 'metrics.exemptions.create',
    params: { body: { metric: 'payments_total', keep_labels: ['customer'], reason: 'billing' } },
    confirm: 'payments_total',
    shows: `on Adaptive Metrics instance ${IDS.metrics}: exempts "payments_total", keeping labels "customer"`,
    done: (s) => [...s.metricExemptions.values()].some((e) => e.metric === 'payments_total'),
  },
  {
    key: 'metrics.exemptions.update',
    params: { path: { id: 'ex-1' }, body: { metric: 'slo_errors_total', keep_labels: ['service'] } },
    confirm: 'slo_errors_total',
    shows: 'on slo_errors_total: exempts "slo_errors_total", keeping labels "service" (was "slo_errors_total")',
    done: (s) => s.metricExemptions.get('ex-1')?.disable_recommendations === undefined,
  },
  {
    key: 'metrics.exemptions.delete',
    params: { path: { id: 'ex-1' } },
    confirm: 'slo_errors_total',
    shows: 'on slo_errors_total: removes the exemption of "slo_errors_total"',
    done: (s) => !s.metricExemptions.has('ex-1'),
  },
  {
    key: 'logs.dropRules.create',
    params: {
      body: {
        version: 1,
        name: 'drop-healthz',
        body: { drop_rate: 1, stream_selector: '{app="web"}', levels: ['info'], log_line_contains: ['/healthz'] },
      },
    },
    confirm: 'drop-healthz',
    shows: `on Adaptive Logs instance ${IDS.logs}: drop_rate 1 on the lines of "{app=\\"web\\"}" at levels "info" containing "/healthz"`,
    done: (s) => [...s.dropRules.values()].some((r) => r.name === 'drop-healthz'),
  },
  {
    key: 'logs.dropRules.update',
    params: {
      path: { id: 'dr-1' },
      body: { version: 1, name: 'drop-debug', body: { drop_rate: 1, stream_selector: '{app="api"}' } },
    },
    confirm: 'drop-debug',
    shows:
      'on drop-debug: drop_rate 1 on the lines of "{app=\\"api\\"}" at every level (rule "drop-debug") (was drop_rate 0.9',
    done: (s) => (s.dropRules.get('dr-1')?.body as { drop_rate?: number }).drop_rate === 1,
  },
  {
    key: 'logs.dropRules.delete',
    params: { path: { id: 'dr-1' } },
    confirm: 'drop-debug',
    shows: 'on drop-debug: removes drop rule drop_rate 0.9 on the lines of "{app=\\"api\\"}"',
    done: (s) => !s.dropRules.has('dr-1'),
  },
  {
    key: 'logs.exemptions.create',
    params: { body: { stream_selector: '{app="audit"}', reason: 'compliance' } },
    confirm: '{app="audit"}',
    shows: `on Adaptive Logs instance ${IDS.logs}: never drops the lines of "{app=\\"audit\\"}"`,
    done: (s) => [...s.logExemptions.values()].some((e) => e.stream_selector === '{app="audit"}'),
  },
  {
    key: 'logs.exemptions.update',
    params: { path: { id: 'lex-1' }, body: { stream_selector: '{app="payments", env="prod"}' } },
    confirm: '{app="payments"}',
    shows: 'on {app=\\"payments\\"}: never drops the lines of "{app=\\"payments\\", env=\\"prod\\"}"',
    done: (s) => s.logExemptions.get('lex-1')?.stream_selector === '{app="payments", env="prod"}',
  },
  {
    key: 'logs.exemptions.delete',
    params: { path: { id: 'lex-1' } },
    confirm: '{app="payments"}',
    shows: 'on {app=\\"payments\\"}: removes the exemption of "{app=\\"payments\\"}"',
    done: (s) => !s.logExemptions.has('lex-1'),
  },
  {
    key: 'traces.policies.create',
    params: { body: { type: 'probabilistic', name: 'sample-1', body: { sampling_percentage: 1 } } },
    confirm: 'sample-1',
    shows: `on Adaptive Traces instance ${IDS.traces}: policy "sample-1" of type "probabilistic"`,
    done: (s) => [...s.policies.values()].some((p) => p.name === 'sample-1'),
  },
  {
    key: 'traces.policies.update',
    params: {
      path: { id: 'pol-1' },
      body: { type: 'probabilistic', name: 'keep-1-percent', body: { sampling_percentage: 1 } },
    },
    confirm: 'keep-5-percent',
    shows: 'on keep-5-percent: policy "keep-1-percent" of type "probabilistic"',
    done: (s) => s.policies.get('pol-1')?.name === 'keep-1-percent',
  },
  {
    key: 'traces.policies.delete',
    params: { path: { id: 'pol-1' } },
    confirm: 'keep-5-percent',
    shows: 'on keep-5-percent: removes policy "keep-5-percent" of type "probabilistic"',
    done: (s) => !s.policies.has('pol-1'),
  },
  {
    key: 'traces.recommendations.apply',
    params: { path: { id: 'rec-1' } },
    confirm: IDS.traces,
    shows: `on Adaptive Traces instance ${IDS.traces}, recommendation rec-1: recommendation "rec-1": "Sample health checks at 1%"; actions: add policy "health-checks" of type "probabilistic"`,
    done: (s) => s.traceRecommendations[0]?.applied === true,
  },
];
