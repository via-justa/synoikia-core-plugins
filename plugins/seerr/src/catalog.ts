import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { parse } from 'yaml';

/**
 * Turns Seerr's `seerr-api.yml` (OpenAPI 3.0) into the catalog (SR §2.2–§2.3). Classification is
 * layered and fails closed: a hardcoded locked list always wins, then the HTTP verb (GET reads,
 * everything else writes). A GET whose summary, description or query parameters read like an action
 * ("reset", "sync", …) is a write flagged for review unless it has been reviewed here; one that really
 * changes something belongs in `LOCKED`, or gets a locked split key (`SPLITS`) when only some calls do.
 */

export const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Verb = (typeof VERBS)[number];

/** Irreversible or affecting other users/integrations: always a human with a typed confirmation (SR §3.4). */
export const LOCKED = new Set([
  'DELETE /user/{userId}',
  'PUT /user',
  'DELETE /settings/radarr/{radarrId}',
  'DELETE /settings/sonarr/{sonarrId}',
  'POST /settings/initialize',
  'POST /settings/main/regenerate',
  'DELETE /settings/discover/{sliderId}',
  'GET /settings/discover/reset',
  // Seerr 3.0–3.4.1 re-saves the enabled-library list on every call: without `enable`, every library is
  // disabled. From 3.5.0 these are plain reads; locking them there only over-locks (fail closed).
  'GET /settings/plex/library',
  'GET /settings/jellyfin/library',
]);

/**
 * Operations whose risk depends on the call (design §3.4): each gets a second, locked key that
 * `resolveOperation` picks when the condition holds.
 * - `#on-behalf`: approving or declining a request someone else filed (SR §3.4).
 * - `#start`: starting a full library scan (SR §2.3), as opposed to reading or cancelling one, and
 *   running any scheduled job not in `CHEAP_JOBS` (`plex-full-scan` starts the same scan).
 */
export const SPLITS: Record<string, string> = {
  'POST /request/{requestId}/{status}': '#on-behalf',
  'POST /settings/plex/sync': '#start',
  'POST /settings/jellyfin/sync': '#start',
  'POST /settings/jobs/{jobId}/run': '#start',
};

/**
 * Scheduled jobs (Seerr `server/job/schedule.ts`) that are cheap to run on demand. Running any other
 * job, including one a future Seerr adds, takes the locked `#start` key: the full library scans,
 * `availability-sync` (can mark media unavailable), `download-sync-reset`, `process-blocklisted-tags`.
 */
export const CHEAP_JOBS = new Set([
  'plex-recently-added-scan',
  'jellyfin-recently-added-scan',
  'plex-refresh-token',
  'plex-watchlist-sync',
  'radarr-scan',
  'sonarr-scan',
  'download-sync',
  'image-cache-cleanup',
]);

/** SR §2.3 "GET as action": summary/description words that suggest a GET changes something. */
const ACTION_WORDS = /\b(reset\w*|regenerat\w*|sync\w*|flush\w*|run|runs|cancel\w*|invok\w*)\b/i;

/**
 * GETs the heuristic flags that were reviewed and are plain reads. A newly flagged GET that is in
 * neither this list nor `LOCKED` is classified write until someone reviews it.
 */
export const REVIEWED_READS = new Set([
  'GET /settings/jellyfin/sync', // "Get status of full Jellyfin library sync"
]);

/** The raw heuristic, before the locked and reviewed lists apply (for the regression test). */
export function looksLikeAction(key: string, text: string): boolean {
  return key.startsWith('GET ') && ACTION_WORDS.test(text);
}

/** Guard against an empty or truncated fetch replacing a real catalog (SR §5). */
export const MIN_OPERATIONS = 50;

export class SpecError extends Error {}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
}

export interface Operation {
  key: string;
  method: Verb;
  template: string;
  /** Template segments; `{name}` marks a path parameter. */
  segments: string[];
}

export interface Catalog {
  operations: OperationDescriptor[];
  /** Operations by verb, most specific template first (literal segments beat `{params}`). */
  byVerb: Map<Verb, Operation[]>;
}

export function classify(
  key: string,
  text = '',
): { classification: 'read' | 'write'; reason: string; locked: boolean; needsReview: boolean } {
  const method = key.split(' ')[0] as Verb;
  const flagged = looksLikeAction(key, text);
  if (LOCKED.has(key) || key.includes('#')) {
    return { classification: 'write', reason: 'locked:destructive', locked: true, needsReview: flagged };
  }
  if (method === 'GET') {
    if (flagged && !REVIEWED_READS.has(key))
      return { classification: 'write', reason: 'heuristic:get-as-action', locked: false, needsReview: true };
    return { classification: 'read', reason: 'verb:GET', locked: false, needsReview: false };
  }
  return { classification: 'write', reason: `verb:${method}`, locked: false, needsReview: false };
}

/** Access group: the operation's first OpenAPI tag. */
export function groupOf(tags: unknown): string {
  const tag = Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : 'other';
  return (
    tag
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')
      .replace(/^[^a-z0-9]+/, '') || 'other'
  );
}

/** Parses and validates the spec text; throws `SpecError` rather than returning a partial catalog. */
export function parseSpec(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 100 });
  } catch {
    throw new SpecError('The Seerr API spec is not valid YAML');
  }
  if (!doc || typeof doc !== 'object') throw new SpecError('The Seerr API spec is empty');
  const spec = doc as Record<string, unknown>;
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.0'))
    throw new SpecError('The Seerr API spec is not OpenAPI 3.0');
  if (!spec.paths || typeof spec.paths !== 'object') throw new SpecError('The Seerr API spec has no paths');
  return spec;
}

const MAX_SCHEMA_DEPTH = 6;

/** Resolves local `$ref`s so a descriptor's schema stands alone; cycles and deep nesting are cut off. */
function resolveRefs(spec: Record<string, unknown>, value: unknown, depth = 0, seen: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(spec, v, depth, seen));
  if (!value || typeof value !== 'object') return value;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/') || seen.includes(ref) || depth >= MAX_SCHEMA_DEPTH) return { description: `See ${ref}` };
    let target: unknown = spec;
    for (const part of ref.slice(2).split('/')) {
      target = target && typeof target === 'object' ? (target as Record<string, unknown>)[part] : undefined;
    }
    return target === undefined ? { description: `See ${ref}` } : resolveRefs(spec, target, depth + 1, [...seen, ref]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(spec, v, depth, seen);
  return out;
}

/** `{ path, query, body }`, the shape `resolveOperation` produces, as one JSON schema. */
function paramsSchema(spec: Record<string, unknown>, pathParams: unknown[], op: OpenApiOperation) {
  const groups: Record<'path' | 'query', { properties: Record<string, unknown>; required: string[] }> = {
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
  };
  for (const raw of [...pathParams, ...(op.parameters ?? [])]) {
    const p = resolveRefs(spec, raw) as {
      name?: unknown;
      in?: unknown;
      required?: unknown;
      schema?: unknown;
      description?: unknown;
    };
    if (typeof p.name !== 'string' || (p.in !== 'path' && p.in !== 'query')) continue;
    const g = groups[p.in];
    g.properties[p.name] = {
      ...(p.schema as object),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
    };
    if (p.required === true && !g.required.includes(p.name)) g.required.push(p.name);
  }
  const properties: Record<string, unknown> = {};
  for (const [name, g] of Object.entries(groups)) {
    if (Object.keys(g.properties).length)
      properties[name] = {
        type: 'object',
        properties: g.properties,
        ...(g.required.length ? { required: g.required } : {}),
      };
  }
  const body = resolveRefs(spec, op.requestBody) as { content?: Record<string, { schema?: unknown }> } | undefined;
  const bodySchema = body?.content?.['application/json']?.schema;
  if (bodySchema) properties.body = bodySchema;
  return Object.keys(properties).length ? { type: 'object', properties } : undefined;
}

const MATCH_PROFILES: Record<string, string> = { 'POST /request': 'media-request' };

/** Descriptions for split keys, by full key (checked first) or by suffix. */
const SPLIT_DESCRIPTIONS: Record<string, string> = {
  'POST /settings/jobs/{jobId}/run#start':
    'Running a full library scan or another heavy or unknown scheduled job: locked. Cheap jobs (recently added scans, Radarr/Sonarr scans, download sync, …) use the ordinary key.',
  '#on-behalf': 'Approving or declining a request filed by another Seerr user: locked.',
  '#start': 'Starting a full library scan: locked.',
  'GET /settings/plex/library':
    'Seerr 3.0–3.4.1 saves the enabled-library list on every call: libraries not listed in `enable` are disabled. Locked.',
  'GET /settings/jellyfin/library':
    'Seerr 3.0–3.4.1 saves the enabled-library list on every call: libraries not listed in `enable` are disabled. Locked.',
};

/** The text the GET-as-action heuristic reads: summary, description and query parameter descriptions. */
export function actionText(spec: Record<string, unknown>, pathParams: unknown[], op: OpenApiOperation): string {
  const params = [...pathParams, ...(op.parameters ?? [])]
    .map((raw) => resolveRefs(spec, raw) as { in?: unknown; description?: unknown })
    .filter((p) => p.in === 'query' && typeof p.description === 'string')
    .map((p) => p.description as string);
  return [op.summary ?? '', op.description ?? '', ...params].join(' ');
}

export function buildCatalog(specText: string): Catalog {
  const spec = parseSpec(specText);
  const operations: OperationDescriptor[] = [];
  const byVerb = new Map<Verb, Operation[]>(VERBS.map((v) => [v, []]));
  for (const [template, item] of Object.entries(spec.paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object' || !/^\/[A-Za-z0-9_\-./{}]*$/.test(template)) continue;
    const segments = template.split('/').filter(Boolean);
    if (segments.some((s) => s === '.' || s === '..')) continue;
    const pathLevel = Array.isArray((item as { parameters?: unknown }).parameters)
      ? (item as { parameters: unknown[] }).parameters
      : [];
    for (const [verb, rawOp] of Object.entries(item)) {
      const method = verb.toUpperCase() as Verb;
      if (!VERBS.includes(method) || !rawOp || typeof rawOp !== 'object') continue;
      const op = rawOp as OpenApiOperation;
      const key = `${method} ${template}`;
      const text = actionText(spec, pathLevel, op);
      const schema = paramsSchema(spec, pathLevel, op);
      const describe = (k: string): OperationDescriptor => {
        const { classification, reason, locked, needsReview } = classify(k, text);
        const suffix = k.slice(key.length);
        const summary = op.summary?.trim().slice(0, 500);
        const description =
          SPLIT_DESCRIPTIONS[k] ?? SPLIT_DESCRIPTIONS[suffix] ?? op.description?.trim().slice(0, 2000);
        return {
          key: k,
          kind: 'rest',
          group: groupOf(op.tags),
          classification,
          classificationReason: reason,
          locked,
          typedConfirmation: locked,
          needsReview,
          ...(MATCH_PROFILES[k] ? { matchProfile: MATCH_PROFILES[k] } : {}),
          ...(schema ? { paramsSchema: schema } : {}),
          ...(summary || description
            ? { docs: { ...(summary ? { summary } : {}), ...(description ? { description } : {}) } }
            : {}),
        };
      };
      operations.push(describe(key));
      if (SPLITS[key]) operations.push(describe(`${key}${SPLITS[key]}`));
      byVerb.get(method)!.push({ key, method, template, segments });
    }
  }
  if (operations.length < MIN_OPERATIONS)
    throw new SpecError(`The Seerr API spec has only ${operations.length} operations; refusing a partial catalog`);
  for (const list of byVerb.values()) list.sort(bySpecificity);
  return { operations: operations.sort((a, b) => a.key.localeCompare(b.key)), byVerb };
}

const isParam = (segment: string) => segment.startsWith('{') && segment.endsWith('}');

/** Literal segments beat `{params}`, compared left to right: `/request/{id}/retry` before `/request/{id}/{status}`. */
function bySpecificity(a: Operation, b: Operation): number {
  for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
    const pa = isParam(a.segments[i]!);
    const pb = isParam(b.segments[i]!);
    if (pa !== pb) return pa ? 1 : -1;
  }
  return 0;
}

/**
 * Matches a concrete path (`/request/5/approve`, with or without `/api/v1`) against the catalog.
 * Returns the operation and its path parameters, or undefined. Rejects `.`, `..` and empty segments.
 */
export function matchPath(
  catalog: Catalog,
  method: string,
  rawPath: string,
): { op: Operation; pathParams: Record<string, string> } | undefined {
  const ops = catalog.byVerb.get(method.toUpperCase() as Verb);
  if (!ops) return undefined;
  const path = rawPath.split('?')[0]!.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  if (!path.startsWith('/')) return undefined;
  const parts = path.split('/').slice(1);
  if (parts.length && parts.at(-1) === '') parts.pop(); // trailing slash
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return undefined;
  }
  if (decoded.some((p) => p === '' || p === '.' || p === '..' || p.includes('/'))) return undefined;
  for (const op of ops) {
    if (op.segments.length !== decoded.length) continue;
    const pathParams: Record<string, string> = {};
    const ok = op.segments.every((seg, i) => {
      if (isParam(seg)) {
        pathParams[seg.slice(1, -1)] = decoded[i]!;
        return true;
      }
      return seg === decoded[i];
    });
    if (ok) return { op, pathParams };
  }
  return undefined;
}

/** Fills a template from path parameters (each value URL-encoded). */
export function fillTemplate(template: string, pathParams: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || value === '') throw new SpecError(`Missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
}
