import http from 'node:http';
import https from 'node:https';
import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import WebSocket from 'ws';

/**
 * Home Assistant client: the WebSocket API (`/api/websocket`) for services, registries and reads, and
 * the REST API for the automation/script/scene config endpoints, which have no WebSocket command.
 * Connects lazily, signs in with the long-lived token, reconnects on the next call after a drop, and
 * re-subscribes to the events it was asked to watch. The token never appears in errors or logs.
 */

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

interface Pending {
  label: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE = 300;

/** The base URL's origin and path (without a trailing slash); only http(s). */
function parseBase(baseUrl: string): { url: URL; path: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new PluginError(ErrorCodes.InvalidParams, `Unsupported URL scheme ${url.protocol}`);
  return { url, path: url.pathname.replace(/\/+$/, '') };
}

/** `https://ha.lan:8123/` → `wss://ha.lan:8123/api/websocket` (a path in the base URL is kept). */
export function wsUrl(baseUrl: string): string {
  const { url, path } = parseBase(baseUrl);
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${path}/api/websocket`;
}

/** `https://ha.lan:8123/` → `https://ha.lan:8123/api` */
export function restBase(baseUrl: string): string {
  const { url, path } = parseBase(baseUrl);
  return `${url.origin}${path}/api`;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** Maps a Home Assistant error to the plugin error codes core understands (HA §4). */
export function toPluginError(label: string, err: { code?: string; status?: number; message?: string }): PluginError {
  const message = clip(err.message?.trim() || err.code || (err.status ? `HTTP ${err.status}` : 'Unknown error'));
  const data = err.status ? { status: err.status } : err.code ? { code: err.code } : undefined;
  if (err.code === 'unauthorized' || err.status === 401 || err.status === 403)
    return new PluginError(
      ErrorCodes.UpstreamDenied,
      `Home Assistant denied ${label}: insufficient permission (${message})`,
      data,
    );
  if (
    err.code === 'invalid_format' ||
    err.code === 'service_validation_error' ||
    err.status === 400 ||
    err.status === 422
  )
    return new PluginError(ErrorCodes.InvalidParams, `${label}: ${message}`, data);
  return new PluginError(ErrorCodes.UpstreamError, `${label}: ${message}`, data);
}

export class HaClient {
  private ws?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Home Assistant's version, from the auth handshake. */
  version?: string;

  constructor(
    private readonly conn: HaConnection,
    private readonly opts: HaClientOptions = {},
  ) {
    wsUrl(conn.baseUrl); // validate early
  }

  /** Sends one WebSocket command and returns its result. */
  async command(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const ws = await this.connection(timeoutMs);
    return this.send(ws, { ...payload, type }, type, timeoutMs);
  }

  /** One REST call (`/api/...`), returning the parsed JSON body (or null). */
  rest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const label = `${method} ${path}`;
    const url = new URL(`${restBase(this.conn.baseUrl)}${path}`);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.conn.token}`,
            accept: 'application/json',
            ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          },
          timeout: timeoutMs,
          ...(url.protocol === 'https:' ? { rejectUnauthorized: this.conn.verifyTls !== false } : {}),
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const parsed = parseBody(text);
            if (status >= 200 && status < 300) return resolve(parsed);
            const message =
              parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
                ? (parsed as { message: string }).message
                : typeof parsed === 'string'
                  ? parsed
                  : undefined;
            reject(toPluginError(label, { status, message }));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) =>
        reject(
          new PluginError(
            ErrorCodes.UpstreamError,
            err.message === 'timeout' ? `${label}: timed out` : `Home Assistant is unreachable at ${url.host}`,
          ),
        ),
      );
      if (data) req.write(data);
      req.end();
    });
  }

  close(): void {
    this.ws?.terminate();
    this.ws = undefined;
    this.failPending(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant connection closed'));
  }

  private send(ws: WebSocket, msg: Record<string, unknown>, label: string, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new PluginError(ErrorCodes.UpstreamError, `${label}: timed out`));
        },
        timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      this.pending.set(id, { label, resolve, reject, timer });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  private failPending(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private connection(timeoutMs?: number): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.connecting ??= this.open(timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
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
        this.failPending(new PluginError(ErrorCodes.UpstreamError, 'Home Assistant closed the connection'));
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
          message?: string;
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
              void this.send(ws, { type: 'subscribe_events', event_type: eventType }, 'subscribe_events').catch(
                () => {},
              );
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
        if (msg.type !== 'result' || typeof msg.id !== 'number') return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.result ?? null);
        else p.reject(toPluginError(p.label, msg.error ?? {}));
      });
    });
  }
}
