import {
  clip,
  ErrorCodes,
  isPlainObject,
  PluginError,
  statusKind,
  stringOr,
  upstreamError,
} from '@synoikia/plugin-sdk';
import type { HttpJsonClient, HttpResponse, ResolvedTarget } from '@synoikia/plugin-sdk';
import { SECRET_PARAMETER } from './mask.js';
import { buildNumber, jobSegments } from './paths.js';

export const SERVICE = 'Jenkins';

const JOB_TREE = 'fullName,property[parameterDefinitions[name,type]]';

/** A redirect after an action is success only within `base` and not to a sign-in page: a session or SSO
 * redirect means the action never ran. */
export function redirectFailure(location: unknown, base: string): string | undefined {
  if (typeof location !== 'string' || !location) return 'a redirect without a location';
  let url: URL;
  const root = new URL(base.endsWith('/') ? base : `${base}/`);
  try {
    url = new URL(location, root);
  } catch {
    return 'a redirect to an invalid location';
  }
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname))
    return `a redirect outside the base URL (to ${url.host}; check that the Jenkins URL setting matches it)`;
  if (/\/login|securityRealm/i.test(url.pathname)) return 'a redirect to the sign-in page';
  return undefined;
}

/** Jenkins answers actions with a redirect, and error pages in HTML: only a short plain-text body is shown.
 * A read's redirect, and an action's redirect away from `base`, are failures. */
export function checkStatus(res: HttpResponse, label: string, base?: string): void {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status >= 300 && res.status < 400) {
    const failure = base === undefined ? 'a redirect' : redirectFailure(res.headers.location, base);
    if (failure === undefined) return;
    throw upstreamError(SERVICE, 'failed', label, `HTTP ${res.status} (${failure})`, { status: res.status });
  }
  const text = typeof res.body === 'string' ? res.body.trim() : '';
  const message = text && !text.startsWith('<') && text.length <= 300 ? clip(text, 200) : `HTTP ${res.status}`;
  throw upstreamError(SERVICE, statusKind(res.status), label, message, { status: res.status });
}

/** One call, its status checked; `base` (the absolute base URL) allows an action's redirect within it. */
export async function send(
  client: HttpJsonClient,
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; timeoutMs: number; base?: string },
): Promise<HttpResponse> {
  const { base, ...rest } = opts;
  const res = await client.raw(method, path, rest);
  checkStatus(res, `${method} ${path}`, method === 'GET' ? undefined : base);
  return res;
}

export interface JobInfo {
  fullName: string;
  parameters: { name: string; type: string }[];
}

/** A job's stored full name and its parameter definitions. */
export async function jobInfo(client: HttpJsonClient, job: unknown, timeoutMs: number): Promise<JobInfo> {
  const path = `/job/${jobSegments(job)}/api/json`;
  const { body } = await send(client, 'GET', path, { query: { tree: JOB_TREE }, timeoutMs });
  const fullName = isPlainObject(body) ? stringOr(body.fullName) : undefined;
  if (!isPlainObject(body) || !fullName) throw new PluginError(ErrorCodes.UpstreamError, `GET ${path}: not a job`);
  const parameters = (Array.isArray(body.property) ? body.property : []).flatMap((p) =>
    isPlainObject(p) && Array.isArray(p.parameterDefinitions)
      ? p.parameterDefinitions.flatMap((d) => {
          const name = isPlainObject(d) ? stringOr(d.name) : undefined;
          // A definition without a type is treated as a password: it can't be set, and its value is hidden.
          return name ? [{ name, type: (isPlainObject(d) && stringOr(d.type)) || 'unknown-secret' }] : [];
        })
      : [],
  );
  return { fullName, parameters };
}

export const isSecretParameter = (p: { type: string }) => SECRET_PARAMETER.test(p.type) || p.type === 'unknown-secret';

/** Build parameters a trigger may send: each one the job defines, and none a password. */
export function checkTriggerParameters(info: JobInfo, query: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(query)) {
    const def = info.parameters.find((p) => p.name === name);
    if (!def)
      throw new PluginError(
        ErrorCodes.InvalidParams,
        info.parameters.length
          ? `${info.fullName} has no parameter ${clip(name, 80)}; it takes ${info.parameters.map((p) => p.name).join(', ')}`
          : `${info.fullName} takes no parameters`,
      );
    if (isSecretParameter(def))
      throw new PluginError(
        ErrorCodes.InvalidParams,
        `${name} is a password parameter and cannot be set through Synoikia; leave it out to use its default`,
      );
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new PluginError(ErrorCodes.InvalidParams, `parameter ${name} must be a string, number or boolean`);
  }
}

/** What a job or build write acts on, read back from Jenkins: `job` by its stored full name, `build` as
 * `<full name>#<number>` once the build is found. None when it can't be read. Stable across the approval
 * wait (core resolves again and compares), so no status is included. */
export async function jenkinsTargets(
  client: HttpJsonClient,
  path: Record<string, unknown>,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  let info: JobInfo;
  try {
    info = await jobInfo(client, path.job, timeoutMs);
  } catch {
    return [];
  }
  if (path.number === undefined) return [{ kind: 'job', id: info.fullName, name: info.fullName }];
  try {
    const number = buildNumber(path.number, []);
    const res = await send(client, 'GET', `/job/${jobSegments(info.fullName)}/${number}/api/json`, {
      query: { tree: 'number' },
      timeoutMs,
    });
    const found = isPlainObject(res.body) ? stringOr(res.body.number) : undefined;
    if (found !== number) return [];
    return [{ kind: 'build', id: `${info.fullName}#${number}`, name: `${info.fullName} #${number}` }];
  } catch {
    return [];
  }
}

/** `…/queue/item/123/` → 123. */
export function queueIdOf(location: unknown): number | undefined {
  const m = typeof location === 'string' ? /\/queue\/item\/(\d+)\/?$/.exec(location) : null;
  return m ? Number(m[1]) : undefined;
}
