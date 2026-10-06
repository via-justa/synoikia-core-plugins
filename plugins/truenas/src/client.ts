import {
  ErrorCodes,
  joinApiPath,
  PendingRequests,
  PluginError,
  singleFlight,
  upstreamError,
} from '@synoikia/plugin-sdk';
import WebSocket from 'ws';

/** TrueNAS JSON-RPC 2.0 over WebSocket (25.04+): lazy API-key sign-in, reconnect after a drop; the key
 * never appears in errors or logs. */

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

const DENIED_ERRNAMES = new Set(['EACCES', 'EPERM', 'ENOTAUTHENTICATED']);

/** `https://nas.lan/` → `wss://nas.lan/api/current` (a path in the base URL is kept). */
export const apiUrl = (baseUrl: string): string => joinApiPath(baseUrl, '/api/current', { websocket: true });

/** Maps a TrueNAS error to the plugin error codes core understands (TN §4). */
export function toPluginError(method: string, err: RpcError): PluginError {
  const reason = err.data?.reason?.trim() || err.message || 'Unknown TrueNAS error';
  const errname = err.data?.errname;
  if ((errname && DENIED_ERRNAMES.has(errname)) || /not (authori[sz]ed|authenticated)/i.test(reason))
    return upstreamError('TrueNAS', 'denied', method, reason);
  if (err.code === -32602 || (errname === 'EINVAL' && err.data?.extra !== undefined))
    return upstreamError('TrueNAS', 'invalid', method, reason, err.data?.extra);
  if (err.code === -32601) return new PluginError(ErrorCodes.UnknownOperation, `${method} is not a TrueNAS method`);
  return upstreamError('TrueNAS', 'failed', method, reason);
}

export class TrueNasClient {
  private ws?: WebSocket;
  private readonly pending = new PendingRequests(
    (method, ms) => new PluginError(ErrorCodes.UpstreamError, `${method}: TrueNAS did not answer within ${ms} ms`),
  );
  private readonly connect = singleFlight((timeoutMs: number) => this.open(timeoutMs));

  constructor(
    private readonly conn: TrueNasConnection,
    private readonly opts: { timeoutMs?: number; jobPollMs?: number } = {},
  ) {}

  /** Calls a method and returns its result. `timeoutMs` bounds the whole call. */
  async call(method: string, params: unknown[] = [], timeoutMs = this.opts.timeoutMs ?? 30_000): Promise<unknown> {
    const ws = this.ws?.readyState === WebSocket.OPEN ? this.ws : await this.connect(timeoutMs);
    return this.send(ws, method, params, timeoutMs);
  }

  /** Calls a `@job` method and polls the job until it ends or `timeoutMs` runs out; returns its result. */
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
      await new Promise((r) => setTimeout(r, Math.min(this.opts.jobPollMs ?? 250, Math.max(1, left))));
    }
  }

  close() {
    this.ws?.close();
    this.ws = undefined;
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
      this.pending.failAll(new PluginError(ErrorCodes.UpstreamError, 'Connection to TrueNAS closed'));
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
    const { id, promise } = this.pending.start(method, timeoutMs);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
      if (err)
        this.pending.fail(id, new PluginError(ErrorCodes.UpstreamError, `${method}: could not send (${err.message})`));
    });
    return promise;
  }

  private onMessage(data: WebSocket.RawData) {
    let msg: { id?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    // Notifications (collection_update, …) carry no id and are not used.
    const p = this.pending.take(msg.id);
    if (!p) return;
    // Errors name the method only, never echo params (the login call's param is the API key).
    if (msg.error) p.reject(toPluginError(p.label, msg.error));
    else p.resolve(msg.result);
  }
}
