import {
  ErrorCodes,
  errorMessage,
  isPlainObject,
  PluginError,
  requireString,
  singleFlight,
  statusKind,
  stringOr,
  upstreamError,
} from '@synoikia/plugin-sdk';
import type { HttpJsonClient, HttpJsonClientOptions, InitParams } from '@synoikia/plugin-sdk';

/** Signs in renewed this long before the token's own expiry. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** NPM's JWT session: `POST /tokens` with the connection's email and password, sent as a bearer token,
 * renewed before it expires and once more on a 401/403. Credentials never reach errors. */
export class NpmSession {
  private token?: string;
  private expires = 0;
  private readonly email: string;
  private readonly password: string;
  private readonly signIn = singleFlight((http: HttpJsonClient, deadline: number) => this.doSignIn(http, deadline));

  constructor(init: InitParams) {
    this.email = requireString(init.config, 'email');
    this.password = requireString(init.secrets, 'password');
  }

  /** Auth options for an `HttpJsonClient`; `http()` returns that same client (sign-in uses its `raw`). */
  options(http: () => HttpJsonClient): Pick<HttpJsonClientOptions, 'headers' | 'before' | 'onAuthFailure'> {
    return {
      headers: (): Record<string, string> => (this.token ? { authorization: `Bearer ${this.token}` } : {}),
      before: async (deadline) => {
        if (!this.token || Date.now() >= this.expires - RENEW_BEFORE_MS) await this.signIn(http(), deadline);
      },
      onAuthFailure: async (deadline) => {
        this.token = undefined;
        await this.signIn(http(), deadline);
        return true;
      },
    };
  }

  private async doSignIn(http: HttpJsonClient, deadline: number): Promise<void> {
    this.token = undefined;
    const res = await http.raw('POST', '/tokens', {
      body: { identity: this.email, secret: this.password },
      deadline,
    });
    if (res.status < 200 || res.status >= 300) {
      const message = errorMessage(res);
      if (res.status === 400 || res.status === 401 || res.status === 403)
        throw new PluginError(
          ErrorCodes.UpstreamDenied,
          `Nginx Proxy Manager rejected the email or password (${message})`,
        );
      throw upstreamError('Nginx Proxy Manager', statusKind(res.status), 'sign-in', `HTTP ${res.status} (${message})`);
    }
    const body = isPlainObject(res.body) ? res.body : {};
    if (body.requires_2fa === true)
      throw new PluginError(
        ErrorCodes.UpstreamDenied,
        'The Nginx Proxy Manager user has two-factor authentication on; use a dedicated user without it',
      );
    const token = stringOr(body.token);
    if (!token) throw new PluginError(ErrorCodes.UpstreamError, 'Nginx Proxy Manager sign-in returned no token');
    const expires = Date.parse(stringOr(body.expires) ?? '');
    this.token = token;
    // Without a readable expiry, renew within the hour rather than trust it for a day.
    this.expires = Number.isFinite(expires) ? expires : Date.now() + RENEW_BEFORE_MS + 60 * 60_000;
  }
}
