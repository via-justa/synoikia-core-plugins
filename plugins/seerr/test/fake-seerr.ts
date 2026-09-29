import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small fake Seerr for tests: `/api/v1` with local sign-in (cookie) and API-key auth, the handful of
 * endpoints the tests call, secret-bearing settings reads, and the OpenAPI spec served the way GitHub
 * serves it (`/spec/<ref>/seerr-api.yml`). Like Seerr, it answers 403 (not 401) without a session.
 */

export const FAKE_EMAIL = 'mcp@seerr.local';
export const FAKE_PASSWORD = 'fake-seerr-password-123';
export const FAKE_API_KEY = 'fake-seerr-api-key-abcdef';
/** The local user the plugin signs in as. */
export const MCP_USER_ID = 2;

export const SPEC_TEXT = readFileSync(new URL('./fixtures/seerr-api.yml', import.meta.url), 'utf8');

interface Call {
  method: string;
  path: string;
  query: Record<string, string[]>;
  body?: unknown;
  cookie?: string;
  apiKey?: string;
  apiUser?: string;
}

interface MediaRequest {
  id: number;
  status: number;
  is4k: boolean;
  media: { mediaType: string; tmdbId: number };
  requestedBy: { id: number; displayName: string; email: string };
}

export interface FakeSeerr {
  url: string;
  /** Base URL for the plugin's `specBaseUrl`. */
  specUrl: string;
  /** Git refs that have a spec; others 404. */
  specRefs: Set<string>;
  /** Replaces the served spec text (to test validation). */
  specText?: string;
  specFetches: string[];
  version: string;
  calls: Call[];
  requests: Map<number, MediaRequest>;
  users: Map<number, { id: number; email: string; displayName: string }>;
  /** Paths (as sent) that always answer 403, as for an account without the permission. */
  denied: Set<string>;
  /** Invalidates every session cookie (the plugin must sign in again). */
  expireSessions(): void;
  close(): Promise<void>;
}

const USERS = [
  { id: 1, email: 'admin@example.com', displayName: 'Admin' },
  { id: 2, email: FAKE_EMAIL, displayName: 'MCP' },
  { id: 14, email: 'alex@example.com', displayName: 'Alex' },
];

export async function startFakeSeerr(opts: { version?: string } = {}): Promise<FakeSeerr> {
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  const requests = new Map<number, MediaRequest>([
    [7, { id: 7, status: 1, is4k: false, media: { mediaType: 'movie', tmdbId: 603 }, requestedBy: { ...USERS[2]! } }],
    [8, { id: 8, status: 1, is4k: false, media: { mediaType: 'tv', tmdbId: 1399 }, requestedBy: { ...USERS[1]! } }],
  ]);
  let nextRequest = 100;
  const sessions = new Set<string>();
  let nextSession = 1;
  const calls: Call[] = [];
  const denied = new Set<string>();

  const state: Omit<FakeSeerr, 'url' | 'specUrl' | 'expireSessions' | 'close'> = {
    specRefs: new Set(['develop', `v${opts.version ?? '3.4.1'}`]),
    specFetches: [],
    version: opts.version ?? '3.4.1',
    calls,
    requests,
    users,
    denied,
  };

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(raw);
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';

    if (url.pathname.startsWith('/spec/')) {
      const [, , ref, file] = url.pathname.split('/');
      state.specFetches.push(ref ?? '');
      if (file !== 'seerr-api.yml' || !state.specRefs.has(ref ?? '')) return json(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(state.specText ?? SPEC_TEXT);
    }
    if (!url.pathname.startsWith('/api/v1/')) return json(res, 404, { message: 'Not Found' });
    const path = url.pathname.slice('/api/v1'.length);
    const body = await readBody(req);
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    const cookie = /connect\.sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const apiUser = req.headers['x-api-user'] as string | undefined;
    calls.push({
      method,
      path,
      query,
      body: path === '/auth/local' ? '<redacted>' : body,
      ...(cookie ? { cookie } : {}),
      ...(apiKey ? { apiKey: '<set>' } : {}),
      ...(apiUser ? { apiUser } : {}),
    });

    // Public endpoints.
    if (method === 'GET' && path === '/status') return json(res, 200, { version: state.version, commitTag: 'local' });
    if (method === 'GET' && path === '/settings/public') return json(res, 200, { applicationTitle: 'Home Seerr' });
    if (method === 'POST' && path === '/auth/local') {
      const { email, password } = (body ?? {}) as { email?: string; password?: string };
      if (email !== FAKE_EMAIL || password !== FAKE_PASSWORD) return json(res, 403, { message: 'Access denied.' });
      const sid = `s%3Asession-${nextSession++}`;
      sessions.add(sid);
      return json(res, 200, USERS[1], { 'set-cookie': [`connect.sid=${sid}; Path=/; HttpOnly`, 'other=1; Path=/'] });
    }

    // Everything else needs a session or the API key.
    let userId: number | undefined;
    if (cookie && sessions.has(cookie)) userId = MCP_USER_ID;
    else if (apiKey === FAKE_API_KEY) userId = apiUser ? Number(apiUser) : 1;
    if (userId === undefined || denied.has(path))
      return json(res, 403, { message: 'You do not have permission to access this endpoint.' });

    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    if (method === 'GET' && path === '/auth/me') return json(res, 200, users.get(userId));
    if (method === 'GET' && path === '/settings/main')
      return json(res, 200, { applicationTitle: 'Home Seerr', apiKey: 'seerr-main-api-key-123', hideAvailable: false });
    if (method === 'GET' && path === '/settings/notifications/telegram')
      return json(res, 200, { enabled: true, types: 2, options: { botAPI: 'tg-bot-secret-456', chatId: '42' } });
    if (method === 'GET' && path === '/settings/notifications/webhook')
      return json(res, 200, {
        enabled: true,
        options: { webhookUrl: 'https://hooks.example/secret-789', authHeader: 'Bearer hook-secret-000' },
      });
    if (method === 'GET' && path === '/settings/radarr')
      return json(res, 200, [{ id: 0, name: 'Radarr 4K', apiKey: 'radarr-key-111', hostname: 'radarr' }]);
    if (method === 'GET' && path === '/settings/discover') return json(res, 200, [{ id: 3, title: 'Trending' }]);
    if (method === 'GET' && path === '/request')
      return json(res, 200, { pageInfo: { results: requests.size }, results: [...requests.values()] });
    if (method === 'POST' && path === '/request') {
      const b = (body ?? {}) as { mediaType?: string; mediaId?: number; is4k?: boolean };
      if (b.mediaType !== 'movie' && b.mediaType !== 'tv') return json(res, 400, { message: 'Invalid media type' });
      const row: MediaRequest = {
        id: nextRequest++,
        status: 1,
        is4k: b.is4k === true,
        media: { mediaType: b.mediaType, tmdbId: Number(b.mediaId) },
        requestedBy: { ...users.get(userId)! },
      };
      requests.set(row.id, row);
      return json(res, 201, row);
    }
    if ((r = m(/^\/request\/(\d+)$/))) {
      const row = requests.get(Number(r[1]));
      if (!row) return json(res, 404, { message: 'Request not found.' });
      if (method === 'GET') return json(res, 200, row);
      if (method === 'DELETE') {
        requests.delete(row.id);
        return json(res, 204, undefined);
      }
    }
    if (method === 'POST' && (r = m(/^\/request\/(\d+)\/(approve|decline)$/))) {
      const row = requests.get(Number(r[1]));
      if (!row) return json(res, 404, { message: 'Request not found.' });
      row.status = r[2] === 'approve' ? 2 : 3;
      return json(res, 200, row);
    }
    if ((r = m(/^\/user\/(\d+)$/))) {
      const user = users.get(Number(r[1]));
      if (!user) return json(res, 404, { message: 'User not found.' });
      if (method === 'GET') return json(res, 200, user);
      if (method === 'DELETE') {
        users.delete(user.id);
        return json(res, 200, user);
      }
    }
    if (method === 'POST' && path === '/settings/plex/sync') return json(res, 200, { running: true, progress: 0 });
    if (method === 'GET' && path === '/movie/603') return json(res, 200, { id: 603, title: 'The Matrix' });
    return json(res, 404, { message: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return Object.assign(state, {
    url: base,
    specUrl: `${base}/spec`,
    expireSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as FakeSeerr;
}
