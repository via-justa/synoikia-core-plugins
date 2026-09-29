import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';

/**
 * Seerr REST client (`<baseUrl>/api/v1`). Signs in either as a dedicated local user (cookie session
 * from `POST /auth/local`) or with the global API key (`X-Api-Key`, optionally `X-API-User`). Seerr
 * answers 403, not 401, when a session has expired, so a local-user client signs in again once and
 * retries; the first attempt never reached the handler. Credentials never appear in errors.
 */

export type SeerrAuth =
  { kind: 'local'; email: string; password: string } | { kind: 'apiKey'; apiKey: string; actAsUserId?: number };

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE = 300;

/** `https://seerr.lan/` → `https://seerr.lan/api/v1` (a path in the base URL is kept). */
export function apiBase(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new PluginError(ErrorCodes.InvalidParams, `Unsupported URL scheme ${url.protocol}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v1`;
}

/** Query string: arrays repeat the key, objects are sent as JSON, null/undefined are dropped. */
export function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null) continue;
      search.append(key, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

async function upstreamMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const msg = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof msg === 'string' && msg) return msg.slice(0, MAX_MESSAGE);
    } catch {
      // not JSON
    }
    return res.statusText || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Maps a Seerr HTTP error to the plugin error codes core understands (SR §4). */
export function toPluginError(label: string, status: number, message: string): PluginError {
  if (status === 401 || status === 403)
    return new PluginError(ErrorCodes.UpstreamDenied, `Seerr denied ${label}: insufficient permission (${message})`);
  if (status === 400 || status === 422) return new PluginError(ErrorCodes.InvalidParams, `${label}: ${message}`);
  return new PluginError(ErrorCodes.UpstreamError, `${label}: HTTP ${status} (${message})`);
}

export class SeerrClient {
  private readonly base: string;
  private cookie?: string;
  private signingIn?: Promise<void>;

  constructor(
    baseUrl: string,
    private readonly auth: SeerrAuth,
  ) {
    this.base = apiBase(baseUrl);
  }

  /** Performs one API call and returns the parsed JSON body (or text, or null for an empty body). */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const label = `${method} ${path}`;
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (this.auth.kind === 'local' && !this.cookie) await this.signIn(deadline);
    let res = await this.send(method, path, opts, deadline);
    if ((res.status === 401 || res.status === 403) && this.auth.kind === 'local') {
      await res.body?.cancel();
      this.cookie = undefined;
      await this.signIn(deadline);
      res = await this.send(method, path, opts, deadline);
    }
    if (!res.ok) throw toPluginError(label, res.status, await upstreamMessage(res));
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  close(): void {
    this.cookie = undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.auth.kind === 'apiKey') {
      h['x-api-key'] = this.auth.apiKey;
      if (this.auth.actAsUserId) h['x-api-user'] = String(this.auth.actAsUserId);
    } else if (this.cookie) {
      h.cookie = this.cookie;
    }
    return h;
  }

  private async send(method: string, path: string, opts: RequestOptions, deadline: number): Promise<Response> {
    const hasBody = opts.body !== undefined && method !== 'GET';
    const left = deadline - Date.now();
    if (left <= 0) throw new PluginError(ErrorCodes.UpstreamError, `${method} ${path}: timed out`);
    try {
      return await fetch(`${this.base}${path}${queryString(opts.query)}`, {
        method,
        headers: { ...this.headers(), ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(left),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new PluginError(
        ErrorCodes.UpstreamError,
        timedOut ? `${method} ${path}: timed out` : `Seerr is unreachable at ${new URL(this.base).host}`,
      );
    }
  }

  private signIn(deadline: number): Promise<void> {
    this.signingIn ??= this.doSignIn(deadline).finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async doSignIn(deadline: number): Promise<void> {
    if (this.auth.kind !== 'local') return;
    const res = await this.send(
      'POST',
      '/auth/local',
      { body: { email: this.auth.email, password: this.auth.password } },
      deadline,
    );
    if (!res.ok) {
      const message = await upstreamMessage(res);
      if (res.status === 401 || res.status === 403)
        throw new PluginError(
          ErrorCodes.UpstreamDenied,
          `Seerr rejected the local user's email or password (${message})`,
        );
      throw toPluginError('sign-in', res.status, message);
    }
    await res.body?.cancel();
    const sid = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!.trim())
      .find((c) => c.startsWith('connect.sid='));
    if (!sid) throw new PluginError(ErrorCodes.UpstreamError, 'Seerr sign-in returned no session cookie');
    this.cookie = sid;
  }
}
