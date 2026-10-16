import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Backstage backend: the pinned v1.55.3 specs at /api/<plugin>/openapi.json, a static external-access
 * token on /api, the endpoints the tests call, and a task result holding secrets that must never reach the
 * sandbox. */

export const FAKE_TOKEN = 'fake-backstage-static-token-abcdef';
export const CREDENTIALS = { token: FAKE_TOKEN };
export const PLUGIN_IDS = ['catalog', 'scaffolder', 'search', 'events', 'notifications'] as const;
/** catalog's info.version, which the plugin reports. */
export const VERSION = '1';

export const SPECS: Record<string, string> = Object.fromEntries(
  PLUGIN_IDS.map((id) => [id, readFileSync(new URL(`./fixtures/${id}-openapi.json`, import.meta.url), 'utf8')]),
);
export const specsOf = (ids: readonly string[] = PLUGIN_IDS) => ids.map((id) => ({ id, spec: SPECS[id]! }));

/** A secret a task result would carry if Backstage stopped stripping it, and the caller's token Backstage hands
 * dry-run steps as secrets.backstageToken. */
export const SECRETS = { taskSecret: 'gho_task-secret-111111', backstageToken: 'eyJ.backstage-user-token.555555' };

export const PETSTORE_UID = '7f3e9a00-0000-4000-8000-000000000001';
export const LOCATION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
export const LOCATION_TARGET = 'https://github.com/acme/catalog/blob/main/catalog-info.yaml';
export const TASK_ID = 'task-0001';

const entity = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind,
  metadata: { namespace: 'default', name, uid: `${kind}-${name}`, ...extra },
  spec: {},
});

export const initialEntities = () => [
  {
    ...entity('Component', 'petstore', { uid: PETSTORE_UID }),
    spec: { type: 'service', owner: 'group:default/team-a' },
  },
  { ...entity('Component', 'billing'), spec: { type: 'service', owner: 'group:default/team-b' } },
  entity('Group', 'team-a'),
  entity('Template', 'react-app', { title: 'React app' }),
];

export interface FakeBackstage extends FakeHttp {
  entities: Record<string, unknown>[];
  locations: Map<string, { id: string; type: string; target: string }>;
  /** Plugins whose routes answer 404, as when they are not installed. */
  missing: Set<string>;
  /** Paths answered 403. */
  denied: Set<string>;
  /** Replaces what a plugin's openapi.json serves (to test validation). */
  serveSpec(id: string, spec: unknown): void;
  reset(): void;
}

const ok = (body: unknown = {}): FakeResponse => ({ body });
const notFound = (what: string): FakeResponse => ({
  status: 404,
  body: { error: { name: 'NotFoundError', message: what } },
});

export async function startFakeBackstage(): Promise<FakeBackstage> {
  const specs = new Map<string, unknown>(PLUGIN_IDS.map((id) => [id, JSON.parse(SPECS[id]!)]));
  const missing = new Set<string>();
  const denied = new Set<string>();
  let entities: Record<string, unknown>[] = initialEntities();
  const locations = new Map<string, { id: string; type: string; target: string }>();
  const reset = () => {
    entities.splice(0, entities.length, ...initialEntities());
    locations.clear();
    locations.set(LOCATION_ID, { id: LOCATION_ID, type: 'url', target: LOCATION_TARGET });
  };
  reset();
  const tasks = new Map<string, Record<string, unknown>>([
    [
      TASK_ID,
      {
        id: TASK_ID,
        status: 'processing',
        createdAt: '2026-10-14T10:00:00.000Z',
        spec: {
          apiVersion: 'scaffolder.backstage.io/v1beta3',
          steps: [],
          output: {},
          parameters: { name: 'checkout' },
          templateInfo: {
            entityRef: 'template:default/react-app',
            entity: { metadata: { name: 'react-app', title: 'React app' } },
          },
        },
        secrets: { USER_OAUTH_TOKEN: SECRETS.taskSecret },
      },
    ],
  ]);
  const meta = (e: unknown) => (e as { metadata: Record<string, string> }).metadata;
  const byUid = (uid: string | undefined) => entities.find((e) => meta(e).uid === uid);
  const kindFilter = (req: FakeRequest) => {
    const filter = req.query.getAll('filter').find((f) => f.startsWith('kind='));
    const kind = filter?.slice('kind='.length).toLowerCase();
    return kind ? entities.filter((e) => String(e.kind).toLowerCase() === kind) : entities;
  };
  const created = (req: FakeRequest): FakeResponse => {
    const body = req.body as { type: string; target: string };
    const id = `loc-${locations.size + 1}`;
    locations.set(id, { id, type: body.type, target: body.target });
    return { status: 201, body: { location: { id, ...body }, entities: [] } };
  };

  const fake = await startFakeHttp({
    guard: (req) => {
      const plugin = /^\/api\/([^/]+)/.exec(req.path)?.[1];
      if (!plugin) return undefined;
      if (missing.has(plugin)) return notFound(`No plugin ${plugin}`);
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return { status: 401, body: { error: { name: 'AuthenticationError', message: 'Unauthorized' } } };
      return denied.has(req.path) ? { status: 403, body: { error: { name: 'NotAllowedError' } } } : undefined;
    },
    routes: {
      'GET /api/{plugin}/openapi.json': (req) => {
        const spec = specs.get(req.params.plugin ?? '');
        return spec ? ok(spec) : notFound('No spec');
      },

      'GET /api/catalog/entities': (req) => ok(kindFilter(req)),
      'GET /api/catalog/entities/by-query': (req) => {
        const items = kindFilter(req);
        const limit = Number(req.query.get('limit') ?? items.length);
        const start = Number(req.query.get('cursor') ?? 0);
        const next = start + limit < items.length ? String(start + limit) : undefined;
        return ok({
          items: items.slice(start, start + limit),
          totalItems: items.length,
          pageInfo: { nextCursor: next },
        });
      },
      'GET /api/catalog/entities/by-uid/{uid}': (req) => {
        const e = byUid(req.params.uid);
        return e ? ok(e) : notFound('No entity');
      },
      'DELETE /api/catalog/entities/by-uid/{uid}': (req) => {
        const e = byUid(req.params.uid);
        if (!e) return notFound('No entity');
        entities = entities.filter((x) => x !== e);
        return { status: 204 };
      },
      'GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}': (req) => {
        const e = entities.find(
          (x) =>
            String(x.kind).toLowerCase() === req.params.kind?.toLowerCase() &&
            meta(x).namespace === req.params.namespace &&
            meta(x).name === req.params.name,
        );
        return e ? ok(e) : notFound('No entity');
      },
      'POST /api/catalog/refresh': () => ({ status: 200 }),
      'POST /api/catalog/validate-entity': (req) => {
        const e = (req.body as { entity?: Record<string, unknown> }).entity;
        return e?.kind && isNamed(e)
          ? { status: 200 }
          : { status: 400, body: { errors: [{ name: 'InputError', message: 'metadata.name is required' }] } };
      },
      'POST /api/catalog/analyze-location': (req) =>
        ok({ existingEntityFiles: [], generateEntities: [], location: (req.body as { location: unknown }).location }),
      'GET /api/catalog/locations': () => ok([...locations.values()].map((data) => ({ data }))),
      'GET /api/catalog/locations/{id}': (req) => {
        const loc = locations.get(req.params.id ?? '');
        return loc ? ok(loc) : notFound('No location');
      },
      'POST /api/catalog/locations': created,
      'PUT /api/catalog/locations/{id}': (req) => {
        const loc = locations.get(req.params.id ?? '');
        if (!loc) return notFound('No location');
        Object.assign(loc, req.body);
        return ok(loc);
      },
      'DELETE /api/catalog/locations/{id}': (req) =>
        locations.delete(req.params.id ?? '') ? { status: 204 } : notFound('No location'),

      'GET /api/scaffolder/v2/actions': () =>
        ok([{ id: 'fetch:template', description: 'Renders a template', schema: { input: {} } }]),
      'POST /api/scaffolder/v2/dry-run': (req) => {
        const body = req.body as { values?: Record<string, unknown> };
        return ok({
          log: [{ body: { message: 'Skipping because publish:github does not support dry-run' } }],
          // As fetch:template renders `${{ secrets.backstageToken }}` into a file.
          directoryContents: [
            { path: 'token.txt', base64Content: Buffer.from(SECRETS.backstageToken).toString('base64') },
          ],
          output: { name: body.values?.name },
          steps: [],
        });
      },
      'POST /api/scaffolder/v2/tasks': () => ({ status: 201, body: { id: 'task-0002' } }),
      'GET /api/scaffolder/v2/tasks/{taskId}': (req) => {
        const task = tasks.get(req.params.taskId ?? '');
        return task ? ok(task) : notFound('No task');
      },
      'POST /api/scaffolder/v2/tasks/{taskId}/cancel': (req) =>
        tasks.has(req.params.taskId ?? '') ? ok({ status: 'cancelled' }) : notFound('No task'),
      'POST /api/scaffolder/v2/tasks/{taskId}/retry': (req) =>
        tasks.has(req.params.taskId ?? '') ? { status: 201, body: { id: req.params.taskId } } : notFound('No task'),
      'GET /api/scaffolder/v2/tasks/{taskId}/events': () =>
        ok([{ id: 1, taskId: TASK_ID, type: 'completion', body: { message: 'Run completed' } }]),

      'GET /api/search/query': (req) =>
        ok({ results: [{ type: 'software-catalog', document: { title: req.query.get('term') } }] }),
      'POST /api/notifications/notifications': () => ok([]),
      'POST /api/events/bus/v1/events': () => ({ status: 201 }),
    },
  });
  return {
    ...fake,
    get entities() {
      return entities;
    },
    locations,
    missing,
    denied,
    serveSpec: (id, spec) => {
      specs.set(id, spec);
    },
    reset,
  };
}

const isNamed = (e: Record<string, unknown>) =>
  typeof e.metadata === 'object' && e.metadata !== null && 'name' in e.metadata;
