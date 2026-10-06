import {
  ErrorCodes,
  errorMessage,
  HttpJsonClient,
  joinApiPath,
  PluginError,
  singleFlight,
  statusKind,
  upstreamError,
} from '@synoikia/plugin-sdk';

/** Seerr REST client: signs in as a local user (cookie) or with the API key. Seerr answers 403 for an
 * expired session, so a local-user client signs in again and retries once; credentials never in errors. */

export type SeerrAuth =
  { kind: 'local'; email: string; password: string } | { kind: 'apiKey'; apiKey: string; actAsUserId?: number };

export { queryString } from '@synoikia/plugin-sdk';

/** `https://seerr.lan/` → `https://seerr.lan/api/v1` (a path in the base URL is kept). */
export const apiBase = (baseUrl: string): string => joinApiPath(baseUrl, '/api/v1');

export class SeerrClient {
  private cookie?: string;
  /** The underlying client: auth headers, sign-in and the one retry after an expired session. */
  readonly http: HttpJsonClient;
  private readonly signIn = singleFlight((deadline: number) => this.doSignIn(deadline));

  constructor(
    baseUrl: string,
    private readonly auth: SeerrAuth,
  ) {
    this.http = new HttpJsonClient({
      baseUrl: apiBase(baseUrl),
      service: 'Seerr',
      headers: () => this.headers(),
      before: async (deadline) => {
        if (this.auth.kind === 'local' && !this.cookie) await this.signIn(deadline);
      },
      onAuthFailure: async (deadline) => {
        if (this.auth.kind !== 'local') return false;
        this.cookie = undefined;
        await this.signIn(deadline);
        return true;
      },
    });
  }

  /** Performs one API call and returns the parsed JSON body (or text, or null for an empty body). */
  request(method: string, path: string, opts?: Parameters<HttpJsonClient['request']>[2]): Promise<unknown> {
    return this.http.request(method, path, opts);
  }

  close(): void {
    this.cookie = undefined;
  }

  private headers(): Record<string, string> {
    if (this.auth.kind === 'apiKey')
      return {
        'x-api-key': this.auth.apiKey,
        ...(this.auth.actAsUserId ? { 'x-api-user': String(this.auth.actAsUserId) } : {}),
      };
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private async doSignIn(deadline: number): Promise<void> {
    if (this.auth.kind !== 'local') return;
    const res = await this.http.raw('POST', '/auth/local', {
      body: { email: this.auth.email, password: this.auth.password },
      deadline,
    });
    if (res.status < 200 || res.status >= 300) {
      const message = errorMessage(res);
      if (res.status === 401 || res.status === 403)
        throw new PluginError(
          ErrorCodes.UpstreamDenied,
          `Seerr rejected the local user's email or password (${message})`,
        );
      throw upstreamError('Seerr', statusKind(res.status), 'sign-in', `HTTP ${res.status} (${message})`);
    }
    const sid = (res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0]!.trim())
      .find((c) => c.startsWith('connect.sid='));
    if (!sid) throw new PluginError(ErrorCodes.UpstreamError, 'Seerr sign-in returned no session cookie');
    this.cookie = sid;
  }
}
