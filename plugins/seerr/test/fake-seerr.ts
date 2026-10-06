import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Seerr: `/api/v1` with cookie and API-key auth, the endpoints the tests use, and the spec;
 * like Seerr, 403 without a session. */

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

  const json = (status: number, body?: unknown, headers?: Record<string, string | string[]>): FakeResponse => ({
    status,
    body,
    ...(headers ? { headers } : {}),
  });
  const API = '/api/v1';
  const cookieOf = (req: FakeRequest) => /connect\.sid=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
  /** The signed-in user: a live session cookie, or the API key (acting as `X-API-User` when given). */
  const userOf = (req: FakeRequest): number | undefined => {
    const cookie = cookieOf(req);
    if (cookie && sessions.has(cookie)) return MCP_USER_ID;
    const apiUser = req.headers['x-api-user'] as string | undefined;
    if (req.headers['x-api-key'] === FAKE_API_KEY) return apiUser ? Number(apiUser) : 1;
    return undefined;
  };
  const PUBLIC = new Set(['GET /status', 'GET /settings/public', 'POST /auth/local']);

  const fake = await startFakeHttp({
    // Records each API call and, like Seerr, answers 403 (not 401) without a session or the API key.
    guard(req) {
      if (req.path.startsWith('/spec/')) return undefined;
      if (!req.path.startsWith(`${API}/`)) return json(404, { message: 'Not Found' });
      const path = req.path.slice(API.length);
      const query: Record<string, string[]> = {};
      for (const [k, v] of req.query) (query[k] ??= []).push(v);
      const cookie = cookieOf(req);
      const apiUser = req.headers['x-api-user'] as string | undefined;
      calls.push({
        method: req.method,
        path,
        query,
        body: path === '/auth/local' ? '<redacted>' : req.body,
        ...(cookie ? { cookie } : {}),
        ...(req.headers['x-api-key'] ? { apiKey: '<set>' } : {}),
        ...(apiUser ? { apiUser } : {}),
      });
      if (PUBLIC.has(`${req.method} ${path}`)) return undefined;
      if (userOf(req) === undefined || denied.has(path))
        return json(403, { message: 'You do not have permission to access this endpoint.' });
      return undefined;
    },
    routes: {
      // The spec, served the way GitHub serves it.
      'GET /spec/{ref}/{file}': ({ params }) => {
        state.specFetches.push(params.ref ?? '');
        if (params.file !== 'seerr-api.yml' || !state.specRefs.has(params.ref ?? ''))
          return json(404, { message: 'Not Found' });
        return { body: state.specText ?? SPEC_TEXT, headers: { 'content-type': 'text/plain' } };
      },
      'GET /api/v1/status': () => json(200, { version: state.version, commitTag: 'local' }),
      'GET /api/v1/settings/public': () => json(200, { applicationTitle: 'Home Seerr' }),
      'POST /api/v1/auth/local': ({ body }) => {
        const { email, password } = (body ?? {}) as { email?: string; password?: string };
        if (email !== FAKE_EMAIL || password !== FAKE_PASSWORD) return json(403, { message: 'Access denied.' });
        const sid = `s%3Asession-${nextSession++}`;
        sessions.add(sid);
        return json(200, USERS[1], { 'set-cookie': [`connect.sid=${sid}; Path=/; HttpOnly`, 'other=1; Path=/'] });
      },
      'GET /api/v1/auth/me': (req) => json(200, users.get(userOf(req)!)),
      'GET /api/v1/settings/main': () =>
        json(200, { applicationTitle: 'Home Seerr', apiKey: 'seerr-main-api-key-123', hideAvailable: false }),
      'GET /api/v1/settings/notifications/telegram': () =>
        json(200, { enabled: true, types: 2, options: { botAPI: 'tg-bot-secret-456', chatId: '42' } }),
      'GET /api/v1/settings/notifications/webhook': () =>
        json(200, {
          enabled: true,
          options: { webhookUrl: 'https://hooks.example/secret-789', authHeader: 'Bearer hook-secret-000' },
        }),
      'GET /api/v1/settings/radarr': () =>
        json(200, [{ id: 0, name: 'Radarr 4K', apiKey: 'radarr-key-111', hostname: 'radarr' }]),
      'GET /api/v1/settings/discover': () => json(200, [{ id: 3, title: 'Trending' }]),
      'GET /api/v1/request': () => json(200, { pageInfo: { results: requests.size }, results: [...requests.values()] }),
      'POST /api/v1/request': (req) => {
        const b = (req.body ?? {}) as { mediaType?: string; mediaId?: number; is4k?: boolean };
        if (b.mediaType !== 'movie' && b.mediaType !== 'tv') return json(400, { message: 'Invalid media type' });
        const row: MediaRequest = {
          id: nextRequest++,
          status: 1,
          is4k: b.is4k === true,
          media: { mediaType: b.mediaType, tmdbId: Number(b.mediaId) },
          requestedBy: { ...users.get(userOf(req)!)! },
        };
        requests.set(row.id, row);
        return json(201, row);
      },
      'GET /api/v1/request/{id}': ({ params }) => {
        const row = requests.get(Number(params.id));
        return row ? json(200, row) : json(404, { message: 'Request not found.' });
      },
      'DELETE /api/v1/request/{id}': ({ params }) =>
        requests.delete(Number(params.id)) ? json(204) : json(404, { message: 'Request not found.' }),
      'POST /api/v1/request/{id}/{status}': ({ params }) => {
        const row = requests.get(Number(params.id));
        if (params.status !== 'approve' && params.status !== 'decline') return json(404, { message: 'Not found' });
        if (!row) return json(404, { message: 'Request not found.' });
        row.status = params.status === 'approve' ? 2 : 3;
        return json(200, row);
      },
      'GET /api/v1/user/{id}': ({ params }) => {
        const user = users.get(Number(params.id));
        return user ? json(200, user) : json(404, { message: 'User not found.' });
      },
      'DELETE /api/v1/user/{id}': ({ params }) => {
        const user = users.get(Number(params.id));
        if (!user) return json(404, { message: 'User not found.' });
        users.delete(user.id);
        return json(200, user);
      },
      'POST /api/v1/settings/plex/sync': () => json(200, { running: true, progress: 0 }),
      'GET /api/v1/movie/603': () => json(200, { id: 603, title: 'The Matrix' }),
    },
  });

  return Object.assign(state, {
    url: fake.url,
    specUrl: `${fake.url}/spec`,
    expireSessions: () => sessions.clear(),
    close: fake.close,
  }) as FakeSeerr;
}
