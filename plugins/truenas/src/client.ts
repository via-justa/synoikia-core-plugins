import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import WebSocket from 'ws';

/**
 * TrueNAS JSON-RPC 2.0 client over WebSocket (`wss://<host>/api/current`, TrueNAS 25.04+).
 * Connects lazily, signs in with the API key, and reconnects on the next call after a drop. The
 * API key never appears in errors or logs.
 */

export interface TrueNasConnection {
  baseUrl: string;
  apiKey: string;
  verifyTls?: boolean;
}

interface RpcError {
  code?: number;
  message?: string;
  data?: { error?: number; errname?: string; reason?: string; extra?: unknown };
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DENIED_ERRNAMES = new Set(['EACCES', 'EPERM', 'ENOTAUTHENTICATED']);
const JOB_POLL_MS = 250;

/** `https://nas.lan/` → `wss://nas.lan/api/current` (a path in the base URL is kept). */
export function apiUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'wss:' && url.protocol !== 'ws:')
    throw new PluginError(ErrorCodes.InvalidParams, `Unsupported URL scheme ${url.protocol}`);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/current`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Maps a TrueNAS error to the plugin error codes core understands (TN §4). */
export function toPluginError(method: string, err: RpcError): PluginError {
  const reason = err.data?.reason?.trim() || err.message || 'Unknown TrueNAS error';
  const errname = err.data?.errname;
  if ((errname && DENIED_ERRNAMES.has(errname)) || /not (authori[sz]ed|authenticated)/i.test(reason)) {
    return new PluginError(ErrorCodes.UpstreamDenied, `TrueNAS denied ${method}: insufficient permission (${reason})`);
  }
  if (err.code === -32602 || (errname === 'EINVAL' && err.data?.extra !== undefined)) {
    return new PluginError(ErrorCodes.InvalidParams, `${method}: ${reason}`, err.data?.extra);
  }
  if (err.code === -32601) return new PluginError(ErrorCodes.UnknownOperation, `${method} is not a TrueNAS method`);
  return new PluginError(ErrorCodes.UpstreamError, `${method}: ${reason}`);
}

export class TrueNasClient {
  private ws?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly conn: TrueNasConnection,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  /** Calls a method and returns its result. `timeoutMs` bounds the whole call. */
  async call(method: string, params: unknown[] = [], timeoutMs = this.opts.timeoutMs ?? 30_000): Promise<unknown> {
    const ws = await this.connection(timeoutMs);
    return this.send(ws, method, params, timeoutMs);
  }

  /**
   * Calls a job method (`@job` in TrueNAS): the call returns a job id, then the job is polled until it
   * finishes, fails or `timeoutMs` runs out. Returns the job's result.
   */
  async callJob(method: string, params: unknown[] = [], timeoutMs = this.opts.timeoutMs ?? 30_000): Promise<unknown> {
    const until = Date.now() + timeoutMs;
    const jobId = await this.call(method, params, timeoutMs);
    if (typeof jobId !== 'number') return jobId;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) {
        throw new PluginError(
          ErrorCodes.UpstreamError,
          `${method}: job ${jobId} still running when the time ran out; it may still complete on TrueNAS`,
        );
      }
      const [job] = (await this.call('core.get_jobs', [[['id', '=', jobId]]], left)) as {
        state?: string;
        result?: unknown;
        error?: string | null;
      }[];
      if (job?.state === 'SUCCESS') return job.result;
      if (job?.state === 'FAILED' || job?.state === 'ABORTED') {
        throw toPluginError(method, { message: job.error ?? `job ${job.state.toLowerCase()}` });
      }
      await new Promise((r) => setTimeout(r, Math.min(JOB_POLL_MS, Math.max(1, left))));
    }
  }

  close() {
    this.ws?.close();
    this.ws = undefined;
  }

  private connection(timeoutMs: number): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.connecting ??= this.open(timeoutMs).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(timeoutMs: number): Promise<WebSocket> {
    const url = apiUrl(this.conn.baseUrl);
    const ws = new WebSocket(url, {
      rejectUnauthorized: this.conn.verifyTls !== false,
      handshakeTimeout: Math.min(timeoutMs, 15_000),
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) =>
        reject(new PluginError(ErrorCodes.UpstreamError, `Cannot reach TrueNAS at ${url}: ${err.message}`)),
      );
    });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('error', () => undefined); // 'close' follows and fails what is pending
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new PluginError(ErrorCodes.UpstreamError, 'Connection to TrueNAS closed'));
        this.pending.delete(id);
      }
    });
    const ok = await this.send(ws, 'auth.login_with_api_key', [this.conn.apiKey], timeoutMs).catch((err: unknown) => {
      ws.close();
      throw err;
    });
    if (ok !== true) {
      ws.close();
      throw new PluginError(ErrorCodes.UpstreamDenied, 'TrueNAS rejected the API key');
    }
    this.ws = ws;
    return ws;
  }

  private send(ws: WebSocket, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError(ErrorCodes.UpstreamError, `${method}: TrueNAS did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (!err || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new PluginError(ErrorCodes.UpstreamError, `${method}: could not send (${err.message})`));
      });
    });
  }

  private onMessage(data: WebSocket.RawData) {
    let msg: { id?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // notifications (collection_update, …) are not used
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    // Errors name the method only, never echo params (the login call's param is the API key).
    if (msg.error) p.reject(toPluginError(p.method, msg.error));
    else p.resolve(msg.result);
  }
}
