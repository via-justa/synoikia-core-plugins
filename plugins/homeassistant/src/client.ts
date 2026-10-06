import {
  clip,
  ErrorCodes,
  HttpJsonClient,
  joinApiPath,
  PendingRequests,
  PluginError,
  singleFlight,
  upstreamError,
} from '@synoikia/plugin-sdk';
import WebSocket from 'ws';

/** Home Assistant client: WebSocket API, plus REST for automation/script/scene config. Lazy token sign-in,
 * reconnects and re-subscribes after a drop; the token never appears in errors or logs. */

export interface HaConnection {
  baseUrl: string;
  token: string;
  verifyTls?: boolean;
}

export interface HaClientOptions {
  timeoutMs?: number;
  /** Event types to subscribe to after each sign-in (registry changes, new integrations…). */
  events?: string[];
  onEvent?: (eventType: string, data: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** `https://ha.lan:8123/` → `wss://ha.lan:8123/api/websocket` (a path in the base URL is kept). */
export const wsUrl = (baseUrl: string): string => joinApiPath(baseUrl, '/api/websocket', { websocket: true });

/** `https://ha.lan:8123/` → `https://ha.lan:8123/api` */
export const restBase = (baseUrl: string): string => joinApiPath(baseUrl, '/api');

/** Maps a Home Assistant error to the plugin error codes core understands (HA §4). */
export function toPluginError(label: string, err: { code?: string; status?: number; message?: string }): PluginError {
  const message = clip(err.message?.trim() || err.code || (err.status ? `HTTP ${err.status}` : 'Unknown error'));
  const data = err.status ? { status: err.status } : err.code ? { code: err.code } : undefined;
  if (err.code === 'unauthorized' || err.status === 401 || err.status === 403)
    return upstreamError('Home Assistant', 'denied', label, message, data);
  if (
    err.code === 'invalid_format' ||
    err.code === 'service_validation_error' ||
    err.status === 400 ||
    err.status === 422
  )
    return upstreamError('Home Assistant', 'invalid', label, message, data);
  return upstreamError('Home Assistant', 'failed', label, message, data);
}

export class HaClient {
  private ws?: WebSocket;
  private readonly pending = new PendingRequests();
  private readonly connect = singleFlight((timeoutMs: number) => this.open(timeoutMs));
  private readonly http: HttpJsonClient;
  /** Home Assistant's version, from the auth handshake. */
  version?: string;

  constructor(
    private readonly conn: HaConnection,
    private readonly opts: HaClientOptions = {},
  ) {
    wsUrl(conn.baseUrl); // validate early
    this.http = new HttpJsonClient({
      baseUrl: restBase(conn.baseUrl),
      service: 'Home Assistant',
      verifyTls: conn.verifyTls !== false,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: () => ({ authorization: `Bearer ${conn.token}` }),
    });
  }

  /** Sends one WebSocket command and returns its result. */
  async command(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const timeout = timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ws = this.ws?.readyState === WebSocket.OPEN ? this.ws : await this.connect(timeout);
    return this.send(ws, { ...payload, type }, type, timeout);
  }

  /** One REST call (`/api/...`), returning the parsed JSON body (or null). */
  rest(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.http.request(method, path, { body, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  close(): void {
    this.ws?.terminate();
    this.ws = undefined;
    this.pending.failAll(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant connection closed'));
  }

  private send(ws: WebSocket, msg: Record<string, unknown>, label: string, timeoutMs: number): Promise<unknown> {
    const { id, promise } = this.pending.start(label, timeoutMs);
    ws.send(JSON.stringify({ ...msg, id }));
    return promise;
  }

  private open(timeoutMs: number): Promise<WebSocket> {
    const url = wsUrl(this.conn.baseUrl);
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, {
        rejectUnauthorized: this.conn.verifyTls !== false,
        handshakeTimeout: timeoutMs,
      });
      const fail = (err: PluginError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.terminate();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant did not complete sign-in in time')),
        timeoutMs,
      );
      ws.on('error', () =>
        fail(new PluginError(ErrorCodes.UpstreamError, `Home Assistant is unreachable at ${new URL(url).host}`)),
      );
      ws.on('close', () => {
        if (this.ws === ws) this.ws = undefined;
        this.pending.failAll(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant closed the connection'));
        fail(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant closed the connection during sign-in'));
      });
      ws.on('message', (raw) => {
        let msg: {
          type?: string;
          id?: number;
          success?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
          event?: { event_type?: string; data?: unknown };
          ha_version?: string;
        };
        try {
          msg = JSON.parse(raw.toString()) as typeof msg;
        } catch {
          return;
        }
        if (!settled) {
          if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: this.conn.token }));
          else if (msg.type === 'auth_ok') {
            settled = true;
            clearTimeout(timer);
            this.version = msg.ha_version;
            this.ws = ws;
            for (const eventType of this.opts.events ?? []) {
              void this.send(
                ws,
                { type: 'subscribe_events', event_type: eventType },
                'subscribe_events',
                timeoutMs,
              ).catch(() => {});
            }
            resolve(ws);
          } else if (msg.type === 'auth_invalid')
            fail(new PluginError(ErrorCodes.UpstreamDenied, 'Home Assistant rejected the access token'));
          return;
        }
        if (msg.type === 'event') {
          if (msg.event?.event_type) this.opts.onEvent?.(msg.event.event_type, msg.event.data);
          return;
        }
        if (msg.type !== 'result') return;
        const p = this.pending.take(msg.id);
        if (!p) return;
        if (msg.success) p.resolve(msg.result ?? null);
        else p.reject(toPluginError(p.label, msg.error ?? {}));
      });
    });
  }
}
