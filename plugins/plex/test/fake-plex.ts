import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Plex Media Server: X-Plex-Token auth, JSON MediaContainer responses, the spec served the way GitHub serves
 * it (under /spec/<ref>/…), the stored items the tests touch, and results holding secrets (tokens in fields, URLs
 * and server settings). */

export const FAKE_TOKEN = 'fake-plex-token-abcdef';
export const CREDENTIALS = { token: FAKE_TOKEN };
export const VERSION = '1.42.2.10156-f737b826c';
export const INSTANCE = 'Home Plex';
export const SPEC_REF = 'a632c48261aedefe0bc3a9ae3ddc4bc227abcda0';
export const SPEC_FILE = 'plex-api-spec.yaml';

/** A reduced copy of the spec at SPEC_REF; tests expect its own digest, not the upstream file's plugin.yaml pins. */
export const SPEC_TEXT = readFileSync(new URL('./fixtures/plex-api-spec.yaml', import.meta.url), 'utf8');
export const SPEC_SHA256 = createHash('sha256').update(SPEC_TEXT, 'utf8').digest('hex');

export const SECRETS = {
  onlineToken: 'plex-online-token-111111',
  accountToken: 'account-auth-token-222222',
  serverToken: 'server-access-token-333333',
  providerUrlToken: 'provider-url-token-444444',
  deviceToken: 'device-token-555555',
  certKey: 'certificate-key-666666',
  thumbToken: 'session-thumb-token-777777',
};

type Row = Record<string, unknown> & { ratingKey: string };

export function seed() {
  return {
    sections: new Map<string, { key: string; title: string; type: string }>([
      ['1', { key: '1', title: 'Movies', type: 'movie' }],
      ['2', { key: '2', title: 'TV Shows', type: 'show' }],
    ]),
    items: new Map<string, Row>([
      ['101', { ratingKey: '101', title: 'Inception', year: 2010, type: 'movie', librarySectionID: 1 }],
      ['102', { ratingKey: '102', title: 'Arrival', year: 2016, type: 'movie', librarySectionID: 1 }],
      ['201', { ratingKey: '201', title: 'Nolan Films', type: 'collection', librarySectionID: 1 }],
      ['301', { ratingKey: '301', title: 'Good News About Hell', grandparentTitle: 'Severance', type: 'episode' }],
    ]),
    playlists: new Map<string, Row>([['401', { ratingKey: '401', title: 'Road Trip', playlistType: 'audio' }]]),
    prefs: new Map<string, string>([
      ['FriendlyName', INSTANCE],
      ['PlexOnlineToken', SECRETS.onlineToken],
      ['customCertificateKey', SECRETS.certKey],
      ['allowedNetworks', ''],
    ]),
  };
}

export interface FakePlex extends FakeHttp {
  state: ReturnType<typeof seed>;
  /** Base URL for the plugin's `specBaseUrl`. */
  specUrl: string;
  specFetches: { ref: string; token: unknown }[];
  /** Replaces the served spec (to test validation). */
  specText?: string;
  /** The version `GET /` reports. */
  version: string;
  /** Paths answered 403. */
  denied: Set<string>;
  reset(): void;
}

const container = (body: Record<string, unknown>) => ({ body: { MediaContainer: { size: 0, ...body } } });
const ok: FakeResponse = { body: {} };
const notFound: FakeResponse = { status: 404, body: '<html>404 Not Found</html>' };

export async function startFakePlex(): Promise<FakePlex> {
  const state = seed();
  const reset = () => {
    const fresh = seed();
    const refill = <K, V>(into: Map<K, V>, from: Map<K, V>) => {
      into.clear();
      for (const [k, v] of from) into.set(k, v);
    };
    refill(state.sections, fresh.sections);
    refill(state.items, fresh.items);
    refill(state.playlists, fresh.playlists);
    refill(state.prefs, fresh.prefs);
  };
  const control = {
    specFetches: [] as { ref: string; token: unknown }[],
    specText: undefined as string | undefined,
    version: VERSION,
    denied: new Set<string>(),
  };
  const s = () => state;
  const metadata = (ids: string[]) => ids.map((id) => s().items.get(id)).filter((r): r is Row => r !== undefined);

  const fake = await startFakeHttp({
    guard: (req) => {
      if (req.path.startsWith('/spec/')) return undefined;
      if (req.headers['x-plex-token'] !== FAKE_TOKEN) return { status: 401, body: '<html>401 Unauthorized</html>' };
      return control.denied.has(req.path) ? { status: 403, body: '<html>403 Forbidden</html>' } : undefined;
    },
    routes: {
      [`GET /spec/{ref}/${SPEC_FILE}`]: ({ params, headers }) => {
        control.specFetches.push({ ref: params.ref ?? '', token: headers['x-plex-token'] });
        if (params.ref !== SPEC_REF) return { status: 404, body: '404: Not Found' };
        return { body: control.specText ?? SPEC_TEXT, headers: { 'content-type': 'text/plain' } };
      },
      'GET /': () =>
        container({ friendlyName: INSTANCE, version: control.version, machineIdentifier: 'machine-1', myPlex: true }),
      'GET /identity': () => container({ machineIdentifier: 'machine-1', version: control.version, claimed: true }),
      'GET /library/sections/all': () =>
        container({ title1: 'Plex Library', Directory: [...s().sections.values()].map((d) => ({ ...d })) }),
      'POST /library/sections/all': () => ok,
      'GET /library/sections/{sectionId}': ({ params }) => {
        const d = s().sections.get(params.sectionId ?? '');
        return d ? container({ title1: d.title, librarySectionID: Number(d.key), Directory: [] }) : notFound;
      },
      'PUT /library/sections/{sectionId}': () => ok,
      'DELETE /library/sections/{sectionId}': ({ params }) =>
        s().sections.delete(params.sectionId ?? '') ? ok : notFound,
      'GET /library/sections/{sectionId}/{view}': ({ params }) => {
        if (!s().sections.has(params.sectionId ?? '')) return notFound;
        const rows = [...s().items.values()].filter((m) => String(m.librarySectionID) === params.sectionId);
        return ['all', 'recentlyAdded'].includes(params.view ?? '') ? container({ Metadata: rows }) : ok;
      },
      'POST /library/sections/{sectionId}/{action}': () => ok,
      'PUT /library/sections/{sectionId}/{action}': () => ok,
      'DELETE /library/sections/{sectionId}/collection/{collectionId}': () => ok,
      'GET /library/metadata/{ids}': ({ params }) => {
        const rows = metadata((params.ids ?? '').split(','));
        return rows.length ? container({ size: rows.length, Metadata: rows }) : notFound;
      },
      'DELETE /library/metadata/{ids}': ({ params }) => {
        for (const id of (params.ids ?? '').split(',')) s().items.delete(id);
        return ok;
      },
      'DELETE /library/metadata/{ids}/media/{mediaItem}': () => ok,
      'GET /library/metadata/{ids}/subtitles': () => ok,
      'POST /library/metadata/{ids}/{element}': () => ok,
      'PUT /library/metadata/{ids}/{element}': () => ok,
      'PUT /library/clean/bundles': () => ok,
      'GET /library/optimize': () => ok,
      'POST /library/optimize': () => ok,
      'PUT /library/optimize': () => ok,
      'DELETE /library/caches': () => ok,
      'GET /hubs/search': ({ query }) => {
        const q = (query.get('query') ?? '').toLowerCase();
        const hits = [...s().items.values()].filter((m) => String(m.title).toLowerCase().includes(q));
        return container({ Hub: [{ type: 'movie', title: 'Movies', Metadata: hits }] });
      },
      'GET /status/sessions': () =>
        container({
          size: 1,
          Metadata: [
            {
              ...s().items.get('102'),
              thumb: `/library/metadata/102/thumb/1?X-Plex-Token=${SECRETS.thumbToken}`,
              Session: { id: 'sess-1', bandwidth: 8000, location: 'lan' },
              User: { id: '1', title: 'alice' },
              Player: { title: 'Living Room TV', state: 'playing' },
            },
          ],
        }),
      'POST /status/sessions/terminate': () => ok,
      'PUT /:/scrobble': () => ok,
      'PUT /:/unscrobble': () => ok,
      'GET /:/prefs': () =>
        container({ Setting: [...s().prefs].map(([id, value]) => ({ id, label: id, type: 'text', value })) }),
      'PUT /:/prefs': ({ query }) => {
        for (const [k, v] of query) s().prefs.set(k, v);
        return ok;
      },
      'GET /myplex/account': () => ({
        body: { MyPlex: { authToken: SECRETS.accountToken, username: 'owner', mappingState: 'mapped' } },
      }),
      'GET /servers': () => container({ Server: [{ name: INSTANCE, accessToken: SECRETS.serverToken }] }),
      'GET /devices': () => container({ Device: [{ name: 'Phone', token: SECRETS.deviceToken }] }),
      'GET /media/providers': () =>
        container({
          MediaProvider: [
            {
              identifier: 'tv.plex.provider.example',
              url: `https://provider.example/library?X-Plex-Token=${SECRETS.providerUrlToken}&x=1`,
            },
          ],
        }),
      'POST /media/providers': () => ok,
      'POST /media/grabbers/devices': () => ok,
      'GET /playlists': () => container({ Metadata: [...s().playlists.values()] }),
      'GET /playlists/{playlistId}': ({ params }) => {
        const p = s().playlists.get(params.playlistId ?? '');
        return p ? container({ size: 1, Metadata: [p] }) : notFound;
      },
      'DELETE /playlists': ({ query }) => (s().playlists.delete(query.get('ratingKey') ?? '') ? ok : notFound),
      'DELETE /playlists/{playlistId}': ({ params }) => (s().playlists.delete(params.playlistId ?? '') ? ok : notFound),
      'DELETE /playlists/{playlistId}/items': () => ok,
      'GET /butler': () => ({ body: { ButlerTasks: { ButlerTask: [{ name: 'BackupDatabase', enabled: true }] } } }),
      'POST /butler': () => ok,
      'DELETE /butler': () => ok,
      'POST /butler/{butlerTask}': () => ok,
      'DELETE /activities/{activityId}': () => ok,
      'PUT /updater/apply': () => ok,
      'PUT /livetv/dvrs/{dvrId}': () => ok,
      'PATCH /livetv/dvrs/{dvrId}': () => ok,
      'PUT /livetv/dvrs/{dvrId}/{action}': () => ok,
      'PUT /livetv/dvrs/{dvrId}/devices/{deviceId}': () => ok,
      'PUT /media/grabbers/devices/{deviceId}': () => ok,
      'PUT /media/grabbers/devices/{deviceId}/{action}': () => ok,
      'GET /playQueues/{playQueueId}': ({ params }) =>
        container({ playQueueID: Number(params.playQueueId), Metadata: [s().items.get('102')] }),
    },
  });

  // Tests change `control` in place (version, specText, denied), so it is the object returned.
  return Object.assign(control, {
    url: fake.url,
    requests: fake.requests as FakeRequest[],
    close: () => fake.close(),
    state,
    reset,
    specUrl: `${fake.url}/spec`,
  });
}
