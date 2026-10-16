import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Profilarr v2: the pinned v2.2.0 spec at /api/v1/openapi.json, X-Api-Key auth on /api/v1 (but
 * /health), the endpoints the tests call, and responses holding secrets that must never reach the sandbox. */

export const FAKE_API_KEY = 'fake-profilarr-api-key-abcdef';
export const CREDENTIALS = { apiKey: FAKE_API_KEY };
export const VERSION = '2.2.0';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/profilarr-openapi.json', import.meta.url), 'utf8');

/** Secrets an upstream that stopped stripping them would return: an arr API key and a database's GitHub PAT. */
export const SECRETS = {
  arrApiKey: 'radarr-api-key-111111',
  pat: 'ghp_database-pat-222222',
};

interface Database {
  id: number;
  name: string;
  repository_url: string;
  auto_pull: number;
  personal_access_token?: string;
}

export interface FakeProfilarr extends FakeHttp {
  databases: Map<number, Database>;
  backups: Set<string>;
  /** Paths answered 403. */
  denied: Set<string>;
  /** Replaces what /api/v1/openapi.json serves (to test validation). */
  serveSpec(spec: unknown): void;
}

const ok = (body: unknown = { success: true }): FakeResponse => ({ body });
const API = '/api/v1';

export async function startFakeProfilarr(): Promise<FakeProfilarr> {
  let spec: unknown = JSON.parse(SPEC_TEXT);
  const denied = new Set<string>();
  const databases = new Map<number, Database>([
    [
      1,
      {
        id: 1,
        name: 'Dictionarry',
        repository_url: 'https://github.com/Dictionarry-Hub/database',
        auto_pull: 1,
        personal_access_token: SECRETS.pat,
      },
    ],
  ]);
  const backups = new Set(['backup-2026-10-14-100005.tar.gz']);
  const jobs = new Map<number, { id: number; jobType: string; status: string }>();
  let settings = {
    schedule: 'daily',
    retentionDays: 30,
    enabled: true,
    includeDatabase: true,
    compressionEnabled: true,
  };
  const enqueue = (jobType: string): FakeResponse => {
    const id = jobs.size + 41;
    jobs.set(id, { id, jobType, status: 'success' });
    return { status: 202, body: { jobId: id } };
  };
  const database = (req: FakeRequest) => databases.get(Number(req.params.id));
  const notFound: FakeResponse = { status: 404, body: { error: 'Database not found' } };

  const fake = await startFakeHttp({
    guard: (req) => {
      if (req.path === `${API}/health`) return undefined;
      if (req.headers['x-api-key'] !== FAKE_API_KEY) return { status: 401, body: { error: 'Unauthorized' } };
      return denied.has(req.path) ? { status: 403, body: { error: 'Forbidden' } } : undefined;
    },
    routes: {
      [`GET ${API}/openapi.json`]: () => ok(spec),
      [`GET ${API}/health`]: () => ok({ status: 'healthy', timestamp: '2026-10-14T10:00:00.000Z' }),
      [`GET ${API}/status`]: () =>
        ok({ version: VERSION, uptime: 60, timezone: 'UTC', databases: [], arrs: [], jobs: {}, backups: {} }),
      [`GET ${API}/arr`]: () =>
        ok([{ id: 1, name: 'Radarr', type: 'radarr', url: 'http://radarr:7878', api_key: SECRETS.arrApiKey }]),
      [`GET ${API}/databases`]: () => ok([...databases.values()]),
      [`POST ${API}/databases`]: () => enqueue('pcd.link'),
      [`GET ${API}/databases/{id}`]: (req) => {
        const db = database(req);
        return db ? ok(db) : notFound;
      },
      [`PATCH ${API}/databases/{id}`]: (req) => {
        const db = database(req);
        return db ? ok({ ...db, personal_access_token: undefined, hasPat: true }) : notFound;
      },
      [`DELETE ${API}/databases/{id}`]: (req) => {
        const db = database(req);
        databases.delete(Number(req.params.id));
        return db ? { status: 204 } : notFound;
      },
      [`POST ${API}/databases/{id}/sync`]: (req) => (database(req) ? enqueue('pcd.sync') : notFound),
      [`GET ${API}/jobs/{id}`]: (req) => {
        const job = jobs.get(Number(req.params.id));
        return job ? ok(job) : { status: 404, body: { error: 'Job not found' } };
      },
      [`GET ${API}/backups`]: () => ok([...backups].map((filename) => ({ filename, size: 1024 }))),
      [`POST ${API}/backups`]: () => enqueue('backup.create'),
      [`DELETE ${API}/backups/{filename}`]: (req) => {
        backups.delete(req.params.filename ?? '');
        return ok();
      },
      [`GET ${API}/backups/settings`]: () => ok(settings),
      [`PATCH ${API}/backups/settings`]: (req) => {
        settings = { ...settings, ...(req.body as object) };
        return ok(settings);
      },
      [`GET ${API}/announcements`]: () => ok([{ id: '01J0ANNOUNCE', title: 'Welcome', read: false }]),
    },
  });
  return {
    ...fake,
    databases,
    backups,
    denied,
    serveSpec: (next) => {
      spec = next;
    },
  };
}
