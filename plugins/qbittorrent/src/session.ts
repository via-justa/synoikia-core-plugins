import {
  ErrorCodes,
  errorMessage,
  PluginError,
  requireString,
  singleFlight,
  statusKind,
  upstreamError,
} from '@synoikia/plugin-sdk';
import type { HttpJsonClient, HttpRequestOptions, HttpResponse, InitParams } from '@synoikia/plugin-sdk';

export const SERVICE = 'qBittorrent';

/** qBittorrent 5.0 and 5.1 name the session cookie `SID` (or a configured name); 5.2 and later `QBT_SID_<port>`. */
const SESSION_COOKIE = /^(SID|QBT_SID_\d{1,5})$/;
/** Cookie names RFC 6265 allows, for a configured name that matches neither. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/** The session cookie a sign-in sets, as `name=value`: a known session name first, else the only cookie set. */
export function sessionCookie(header: string | string[] | undefined): string | undefined {
  const cookies = (Array.isArray(header) ? header : header ? [header] : []).flatMap((line) => {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) return [];
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return TOKEN.test(name) && /^[\x21-\x7e]{1,512}$/.test(value) && !value.includes(';') ? [{ name, value }] : [];
  });
  const found = cookies.find((c) => SESSION_COOKIE.test(c.name)) ?? (cookies.length === 1 ? cookies[0] : undefined);
  return found && `${found.name}=${found.value}`;
}

/** Whether a sign-in response accepted the credentials: 5.2 answers 204, older releases 200 `Ok.` (`Fails.` else). */
function signedIn(res: HttpResponse): boolean {
  if (res.status === 204) return true;
  return res.status === 200 && (res.body === null || (typeof res.body === 'string' && res.body.trim() === 'Ok.'));
}

/** qBittorrent answers a request without a valid session with 403 and the bare status text (webapplication.cpp
 * `doProcessRequest`); an action's own 403 ("Cannot write to directory") carries its message. */
export const sessionEnded = (res: HttpResponse) =>
  res.status === 403 && typeof res.body === 'string' && res.body.trim() === 'Forbidden';

/** Host header validation or CSRF protection refused the request before any session check (401, bare text). */
const HOST_REFUSED = `${SERVICE} refused the request before sign-in (HTTP 401): add the base URL's host name to the WebUI's Server domains, or check its CSRF protection and reverse proxy settings`;

/** The WebUI session: `POST /auth/login` with the connection's username and password as a form, and the cookie it
 * sets sent on every call. Credentials and the cookie never reach errors. */
export class QbtSession {
  private cookie?: string;
  private readonly username: string;
  private readonly password: string;
  private readonly signIn = singleFlight((http: HttpJsonClient, deadline: number) => this.doSignIn(http, deadline));

  constructor(init: InitParams) {
    this.username = requireString(init.config, 'username');
    this.password = requireString(init.secrets, 'password');
  }

  headers(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  async ensure(http: HttpJsonClient, deadline: number): Promise<void> {
    if (!this.cookie) await this.signIn(http, deadline);
  }

  async renew(http: HttpJsonClient, deadline: number): Promise<void> {
    this.cookie = undefined;
    await this.signIn(http, deadline);
  }

  private async doSignIn(http: HttpJsonClient, deadline: number): Promise<void> {
    this.cookie = undefined;
    const res = await http.raw('POST', '/auth/login', {
      body: { username: this.username, password: this.password },
      bodyEncoding: 'form',
      deadline,
    });
    if (res.status === 403)
      throw new PluginError(
        ErrorCodes.UpstreamDenied,
        `${SERVICE} refused the sign-in: too many failed attempts banned this address for a while`,
      );
    if (res.status === 401) {
      // 5.2 answers wrong credentials with 401 too; a request without a session tells them apart (403 vs 401).
      const probe = await http.raw('GET', '/app/webapiVersion', { deadline });
      throw new PluginError(
        ErrorCodes.UpstreamDenied,
        probe.status === 401 ? HOST_REFUSED : `${SERVICE} rejected the username or password`,
      );
    }
    if (res.status === 200 && !signedIn(res))
      throw new PluginError(ErrorCodes.UpstreamDenied, `${SERVICE} rejected the username or password`);
    if (!signedIn(res))
      throw upstreamError(SERVICE, statusKind(res.status), 'sign-in', `HTTP ${res.status}`, { status: res.status });
    const cookie = sessionCookie(res.headers['set-cookie']);
    if (!cookie) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} sign-in set no session cookie`);
    this.cookie = cookie;
  }
}

/** The API as the plugin uses it: signs in first, and once more only when qBittorrent says the session ended (the
 * request then never reached the action, so repeating it is safe). Any other error is final, a POST is never
 * repeated after it. */
export class QbtApi {
  constructor(
    readonly http: HttpJsonClient,
    private readonly session: QbtSession,
    private readonly timeoutMs: number,
  ) {}

  async request(method: string, path: string, opts: HttpRequestOptions = {}): Promise<unknown> {
    const deadline = opts.deadline ?? Date.now() + (opts.timeoutMs ?? this.timeoutMs);
    await this.session.ensure(this.http, deadline);
    let res = await this.http.raw(method, path, { ...opts, deadline });
    if (sessionEnded(res)) {
      await this.session.renew(this.http, deadline);
      res = await this.http.raw(method, path, { ...opts, deadline });
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    const label = `${method} ${path}`;
    if (res.status === 401 && errorMessage(res) === 'Unauthorized')
      throw new PluginError(ErrorCodes.UpstreamDenied, HOST_REFUSED);
    const kind = statusKind(res.status);
    const message = errorMessage(res);
    throw upstreamError(SERVICE, kind, label, kind === 'failed' ? `HTTP ${res.status} (${message})` : message, {
      status: res.status,
    });
  }
}
