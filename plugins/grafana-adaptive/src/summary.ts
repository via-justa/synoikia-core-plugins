import { ErrorCodes, isPlainObject, PluginError, queryString, stringOr, truncate } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import type { CallParams, HttpOperation } from './request.js';

/** Names listed in a summary before "and N more". */
const MAX_LISTED = 20;

/** A model-written string as one visible line: control, bidi and zero-width characters escaped. */
export function safe(value: unknown, max = 200): string {
  return JSON.stringify(truncate(String(value), max))
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

const quoted = (v: unknown) => `"${safe(v)}"`;
const list = (values: readonly unknown[]) => {
  const shown = values.slice(0, MAX_LISTED).map(quoted).join(', ');
  return values.length > MAX_LISTED ? `${shown} and ${values.length - MAX_LISTED} more` : shown;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const MATCH_TYPES = ['exact', 'prefix', 'suffix'];

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** The body fields summaries read, checked for the type the Go service binds, so a summary never shows a value the
 * service reads differently (it refuses those too). */
export function checkBodyFields(key: string, body: unknown): void {
  const expect = (
    obj: Record<string, unknown>,
    field: string,
    type: 'string' | 'boolean' | 'number' | 'strings',
    at: string,
  ) => {
    const v = obj[field];
    if (v === undefined) return;
    const ok =
      type === 'strings' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type && v !== '';
    if (!ok) throw invalid(`${at}.${field} must be ${type === 'strings' ? 'a list of strings' : `a ${type}`}`);
  };
  const need = (obj: Record<string, unknown>, field: string, at: string) => {
    if (typeof obj[field] !== 'string' || obj[field] === '') throw invalid(`${at}.${field} is required`);
  };
  // Core does not enforce the plugin.yaml enum, and summaries must not show an unknown match as exact.
  const matchType = (obj: Record<string, unknown>, at: string) => {
    if (obj.match_type !== undefined && !MATCH_TYPES.includes(obj.match_type as string))
      throw invalid(`${at}.match_type must be one of ${MATCH_TYPES.join(', ')}`);
  };
  const rule = (r: unknown, at: string) => {
    if (!isPlainObject(r)) throw invalid(`${at} must be a rule object`);
    need(r, 'metric', at);
    matchType(r, at);
    expect(r, 'drop', 'boolean', at);
    for (const f of ['keep_labels', 'drop_labels', 'aggregations']) expect(r, f, 'strings', at);
  };
  if (body === undefined) return;
  if (key === 'metrics.rules.replace' || key === 'metrics.rules.check') {
    (body as unknown[]).forEach((r, i) => rule(r, `body[${i}]`));
    return;
  }
  const b = body as Record<string, unknown>;
  if (key === 'metrics.rules.create' || key === 'metrics.rules.update') rule(b, 'body');
  else if (key.startsWith('metrics.exemptions.')) {
    need(b, 'metric', 'body');
    matchType(b, 'body');
    expect(b, 'keep_labels', 'strings', 'body');
    expect(b, 'disable_recommendations', 'boolean', 'body');
  } else if (key === 'metrics.recommendations.updateConfig') {
    expect(b, 'keep_labels', 'strings', 'body');
    if (b.auto_apply !== undefined) {
      if (!isPlainObject(b.auto_apply)) throw invalid('body.auto_apply must be an object');
      expect(b.auto_apply, 'enabled', 'boolean', 'body.auto_apply');
      const gate = b.auto_apply.gate;
      if (gate !== undefined && gate !== null) {
        if (!isPlainObject(gate)) throw invalid('body.auto_apply.gate must be an object');
        expect(gate, 'policy', 'string', 'body.auto_apply.gate');
      }
    }
  } else if (key.startsWith('logs.exemptions.')) need(b, 'stream_selector', 'body');
  else if (key.startsWith('logs.dropRules.')) {
    need(b, 'name', 'body');
    expect(b, 'disabled', 'boolean', 'body');
    if (!isPlainObject(b.body)) throw invalid('body.body must be the rule: drop_rate, stream_selector, levels');
    need(b.body, 'stream_selector', 'body.body');
    if (typeof b.body.drop_rate !== 'number' || !(b.body.drop_rate >= 0))
      throw invalid('body.body.drop_rate must be a number');
    for (const f of ['levels', 'log_line_contains']) expect(b.body, f, 'strings', 'body.body');
  } else if (key.startsWith('traces.policies.')) {
    need(b, 'name', 'body');
    need(b, 'type', 'body');
    if (!isPlainObject(b.body)) throw invalid('body.body must be the policy configuration object');
  }
}

/** A rule's or exemption's metric with its match type: `"go_" (prefix match)` reaches every metric it starts. */
const subjectOf = (r: Record<string, unknown>) => {
  const match = stringOr(r.match_type);
  return `${quoted(r.metric)}${match && match !== 'exact' ? ` (${safe(match, 20)} match)` : ''}`;
};

const subjects = (rules: readonly Record<string, unknown>[]) => {
  const shown = rules.slice(0, MAX_LISTED).map(subjectOf).join(', ');
  return rules.length > MAX_LISTED ? `${shown} and ${rules.length - MAX_LISTED} more` : shown;
};

/** One metrics rule in words, what it removes first. */
function ruleText(r: Record<string, unknown>): string {
  const subject = subjectOf(r);
  if (r.drop === true) return `${subject} dropped entirely`;
  const parts: string[] = [];
  const dropLabels = strings(r.drop_labels);
  const keepLabels = strings(r.keep_labels);
  if (dropLabels.length) parts.push(`drop labels ${list(dropLabels)}`);
  if (keepLabels.length) parts.push(`keep only labels ${list(keepLabels)}`);
  const aggs = strings(r.aggregations);
  if (aggs.length) parts.push(`aggregations ${list(aggs)}`);
  return `${subject} aggregated${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

const ruleId = (r: Record<string, unknown>) => `${stringOr(r.match_type) ?? 'exact'}:${String(r.metric)}`;

/** Stable JSON of a rule's effect, ignoring bookkeeping fields and the match type (part of its id). */
function effect(r: Record<string, unknown>): string {
  const { managed_by: _m, match_type: _t, ...rest } = r;
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => [k, rest[k]]);
  return JSON.stringify(sorted);
}

/** A rule set replacement: what will be dropped entirely, then aggregated, then removed, then the counts. */
export function replaceText(sent: Record<string, unknown>[], current: Record<string, unknown>[] | undefined): string {
  if (!current) {
    const dropped = sent.filter((r) => r.drop === true);
    return [
      dropped.length ? `drops entirely: ${subjects(dropped)}` : '',
      `the current rules could not be read; ${sent.length} rules sent replace them all`,
    ]
      .filter(Boolean)
      .join('; ');
  }
  const before = new Map(current.map((r) => [ruleId(r), r]));
  const after = new Map(sent.map((r) => [ruleId(r), r]));
  const added = sent.filter((r) => !before.has(ruleId(r)));
  const changed = sent.filter((r) => {
    const old = before.get(ruleId(r));
    return old !== undefined && effect(old) !== effect(r);
  });
  const removed = current.filter((r) => !after.has(ruleId(r)));
  const touched = [...added, ...changed];
  const drops = touched.filter((r) => r.drop === true);
  const aggregates = touched.filter((r) => r.drop !== true);
  const parts = [
    drops.length ? `drops entirely: ${subjects(drops)}` : '',
    aggregates.length
      ? `aggregates: ${aggregates.slice(0, MAX_LISTED).map(ruleText).join(', ')}${aggregates.length > MAX_LISTED ? ` and ${aggregates.length - MAX_LISTED} more` : ''}`
      : '',
    removed.length ? `removes the rules of ${subjects(removed)} (kept in full again)` : '',
    `${sent.length} rules: ${added.length} added, ${changed.length} changed, ${removed.length} removed, ${sent.length - touched.length} unchanged`,
  ];
  return parts.filter(Boolean).join('; ');
}

const rateText = (b: Record<string, unknown>) => {
  const rule = isPlainObject(b.body) ? b.body : {};
  const levels = strings(rule.levels);
  const contains = strings(rule.log_line_contains);
  return [
    `drop_rate ${safe(rule.drop_rate, 20)} on the lines of ${quoted(rule.stream_selector)}`,
    levels.length ? `at levels ${list(levels)}` : 'at every level',
    contains.length ? `containing ${list(contains)}` : '',
    `(rule ${quoted(b.name)}${b.disabled === true ? ', disabled' : ''}${b.segment_id ? `, segment ${quoted(b.segment_id)}` : ''}${b.expires_at ? `, expires ${quoted(b.expires_at)}` : ''})`,
  ]
    .filter(Boolean)
    .join(' ');
};

const policyText = (b: Record<string, unknown>) =>
  `policy ${quoted(b.name)} of type ${quoted(b.type)}: ${safe(JSON.stringify(b.body ?? {}), 300)}${b.expires_at ? `, expires ${quoted(b.expires_at)}` : ''}`;

/** A trace recommendation's actions: the policies it adds, changes or removes. */
function actionsText(actions: unknown): string {
  if (!Array.isArray(actions)) return 'its actions could not be read';
  const items = actions.filter(isPlainObject).map((a) => {
    const seed = isPlainObject(a.seed) ? a.seed : undefined;
    const what = seed ? policyText(seed) : `policy ${quoted(a.policy_id)}`;
    return `${safe(a.action, 20)} ${what}`;
  });
  return items.length ? `actions: ${items.slice(0, MAX_LISTED).join(', ')}` : 'no actions';
}

/** What a write does, the telemetry it drops or stops protecting first. `stored` is the object it acts on, and
 * `current` the rule set (`metrics.rules.replace`) or settings (`updateConfig`) in force. */
export function detailText(
  key: string,
  params: CallParams,
  stored: Record<string, unknown> | undefined,
  current: unknown,
): string {
  const body = isPlainObject(params.body) ? params.body : {};
  const s = stored ?? {};
  switch (key) {
    case 'metrics.rules.replace':
      return replaceText(
        (params.body as Record<string, unknown>[]) ?? [],
        Array.isArray(current) ? current.filter(isPlainObject) : undefined,
      );
    case 'metrics.rules.create':
      return ruleText(body);
    case 'metrics.rules.update':
      return `${ruleText(body)}${stored ? ` (was ${ruleText(s)})` : ''}`;
    case 'metrics.rules.delete':
      return `removes the rule of ${quoted(params.path?.metric)}${stored ? ` (now ${ruleText(s)})` : ''}; the metric is kept in full again`;
    case 'metrics.recommendations.updateConfig': {
      const auto = isPlainObject(body.auto_apply) ? body.auto_apply : undefined;
      const gate = auto && isPlainObject(auto.gate) ? stringOr(auto.gate.policy) : undefined;
      const autoText =
        auto === undefined
          ? 'auto-apply unchanged or off'
          : auto.enabled === true
            ? `auto-apply ON: recommendations change the rules without review${gate ? ` (gate ${quoted(gate)})` : ''}`
            : 'auto-apply off';
      const keep = strings(body.keep_labels);
      const was = isPlainObject(current) ? strings(current.keep_labels) : undefined;
      const removed = was?.filter((l) => !keep.includes(l)) ?? [];
      const keepText = was
        ? removed.length
          ? `stops keeping labels ${list(removed)} (recommendations may aggregate them away)`
          : 'removes no keep_labels'
        : 'the current settings could not be read';
      return `${autoText}; ${keepText}; keep_labels ${keep.length ? list(keep) : 'none'}`;
    }
    case 'metrics.exemptions.create':
    case 'metrics.exemptions.update': {
      const keep = strings(body.keep_labels);
      return `exempts ${subjectOf(body)}${body.disable_recommendations === true ? ' from all recommendations' : ''}${keep.length ? `, keeping labels ${list(keep)}` : ''}${body.expires_at ? `, expires ${quoted(body.expires_at)}` : ''}${stored ? ` (was ${subjectOf(s)})` : ''}`;
    }
    case 'metrics.exemptions.delete':
      return `removes the exemption of ${stored ? subjectOf(s) : quoted(params.path?.id)}: recommendations may aggregate or drop it again`;
    case 'logs.dropRules.create':
    case 'logs.dropRules.update':
      return `${rateText(body)}${stored ? ` (was ${rateText(s)})` : ''}`;
    case 'logs.dropRules.delete':
      return `removes drop rule ${stored ? rateText(s) : quoted(params.path?.id)}`;
    case 'logs.exemptions.create':
    case 'logs.exemptions.update':
      return `never drops the lines of ${quoted(body.stream_selector)}${body.expires_at ? `, expires ${quoted(body.expires_at)}` : ''}${stored ? ` (was ${quoted(s.stream_selector)})` : ''}`;
    case 'logs.exemptions.delete':
      return `removes the exemption of ${quoted(s.stream_selector ?? params.path?.id)}: its lines may be dropped again`;
    case 'traces.policies.create':
    case 'traces.policies.update':
      return `${policyText(body)}${stored ? ` (was ${policyText(s)})` : ''}`;
    case 'traces.policies.delete':
      return `removes ${stored ? policyText(s) : `policy ${quoted(params.path?.id)}`}`;
    case 'traces.recommendations.apply':
    case 'traces.recommendations.dismiss': {
      const text = `recommendation ${quoted(params.path?.id)}${stored ? `: ${quoted(stored.message)}` : ''}`;
      return key.endsWith('.apply') ? `${text}; ${actionsText(stored?.actions)}` : text;
    }
    default:
      return '';
  }
}

/** `<Service> <key> on <destination>: <what it does> — <METHOD> <path>?<query>`: destination and drops first, so
 * padding cannot push them past the approval's cut. */
export function summaryText(opts: {
  serviceName: string;
  key: string;
  op: HttpOperation;
  path: string;
  params: CallParams;
  targets: readonly ResolvedTarget[];
  instance: string;
  detail: string;
}): string {
  const { serviceName, key, op, path, params, targets, instance, detail } = opts;
  const dest = targets.length ? targets.map((t) => safe(t.name)).join(', ') : instance;
  const segment = params.query?.segment ?? params.query?.segment_id;
  const where = segment === undefined ? dest : `${dest}, segment ${quoted(segment)}`;
  const request = `${op.http.method} ${path}${queryString(params.query)}`;
  return `${serviceName} ${key} on ${where}: ${detail ? `${detail} — ` : ''}${request}`;
}
