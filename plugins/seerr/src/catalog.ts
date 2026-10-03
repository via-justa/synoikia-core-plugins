import {
  actionText,
  buildOpenApiCatalog,
  classifyRest,
  compileRules,
  fillTemplate,
  isPlainObject,
  matchPath as matchRestPath,
  parseOpenApi,
  parsePluginSettings,
  SpecError,
  toGroup,
} from '@synoikia/plugin-sdk';
import type { OpenApiCatalog, OpenApiOperation } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';

/**
 * Seerr's catalog (SR §2.2–§2.3): the SDK's OpenAPI catalog over `seerr-api.yml`, with plugin.yaml's
 * locks, splits and reviewed reads on top. Classification fails closed: a lock always wins, GET reads,
 * every other verb writes, and an action-shaped GET is a write flagged for review until reviewed.
 */

export interface SeerrSettings {
  spec: { baseUrl: string; file: string; fallbackRef: string; maxBytes: number; timeoutMs: number };
  minOperations: number;
  cheapJobs: Set<string>;
  actionWords: RegExp;
}

export const settings = parsePluginSettings<SeerrSettings>(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const spec = isPlainObject(p.spec) ? p.spec : {};
    const text = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v) throw new Error(`plugin.yaml plugin.${name} must be a string`);
      return v;
    };
    const num = (v: unknown, name: string) => {
      if (typeof v !== 'number' || v <= 0) throw new Error(`plugin.yaml plugin.${name} must be a positive number`);
      return v;
    };
    if (!Array.isArray(p.cheapJobs) || !p.cheapJobs.every((j) => typeof j === 'string'))
      throw new Error('plugin.yaml plugin.cheapJobs must be a list of job ids');
    if (!Array.isArray(p.actionWords) || !p.actionWords.every((w) => typeof w === 'string' && /^[\w\\*]+$/.test(w)))
      throw new Error('plugin.yaml plugin.actionWords must be a list of words');
    return {
      actionWords: new RegExp(`\\b(${(p.actionWords as string[]).join('|')})\\b`, 'i'),
      spec: {
        baseUrl: text(spec.baseUrl, 'spec.baseUrl'),
        file: text(spec.file, 'spec.file'),
        fallbackRef: text(spec.fallbackRef, 'spec.fallbackRef'),
        maxBytes: num(spec.maxBytes, 'spec.maxBytes'),
        timeoutMs: num(spec.timeoutMs, 'spec.timeoutMs'),
      },
      minOperations: num(p.minOperations, 'minOperations'),
      cheapJobs: new Set(p.cheapJobs),
    };
  },
});

/** plugin.yaml's rules, without upstream lookups (confirmation literals compile their own per instance). */
export const policy = compileRules(settings);

export { actionText, fillTemplate, parseOpenApi as parseSpec, SpecError };
export type { OpenApiOperation };
export type Catalog = OpenApiCatalog;

export const CHEAP_JOBS = settings.plugin.cheapJobs;

/** Operations plugin.yaml locks by key. */
export const LOCKED = new Set(
  settings.rules
    .filter((r) => r.locked)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((m) => !m.includes('*')),
);

/** GETs the heuristic flags that were reviewed as plain reads. */
export const REVIEWED_READS = new Set(
  settings.rules
    .filter((r) => r.classification === 'read')
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match])),
);

/** The raw heuristic, before the locked and reviewed lists apply (for the regression test). */
export function looksLikeAction(key: string, text: string): boolean {
  return key.startsWith('GET ') && settings.plugin.actionWords.test(text);
}

/** The classification core gets for `key`, with the heuristic reading `text`. */
export function classify(
  key: string,
  text = '',
): { classification: 'read' | 'write'; reason: string; locked: boolean; needsReview: boolean } {
  const d = policy.decorate({
    key,
    kind: 'rest',
    group: 'x',
    ...classifyRest(key, text, settings.plugin.actionWords, null),
  });
  return {
    classification: d.classification,
    reason: d.classificationReason,
    locked: d.locked ?? false,
    needsReview: d.needsReview ?? false,
  };
}

/** Access group: the operation's first OpenAPI tag. */
export function groupOf(tags: unknown): string {
  return toGroup(Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : '', 'other');
}

export function buildCatalog(specText: string, rules = policy): Catalog {
  return buildOpenApiCatalog(specText, {
    service: 'Seerr',
    rules,
    minOperations: settings.plugin.minOperations,
    actionWords: settings.plugin.actionWords,
    pathActionWords: null,
  });
}

/** Matches a concrete path (with or without `/api/v1`) against the catalog. */
export function matchPath(catalog: Catalog, method: string, path: string) {
  return matchRestPath(catalog, method, path, '/api/v1');
}
