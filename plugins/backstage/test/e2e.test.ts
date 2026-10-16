import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, LOCATION_ID, SECRETS, startFakeBackstage, TASK_ID, VERSION } from './fake-backstage.js';
import type { FakeBackstage } from './fake-backstage.js';
import { LOCK_CASES, RETRY_SECRET, SCAFFOLD_SECRET } from './locks.js';

/** The real core running this plugin's built bundle against the fake Backstage, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeBackstage;

beforeAll(async () => {
  fake = await startFakeBackstage();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

const TEMPLATE = {
  apiVersion: 'scaffolder.backstage.io/v1beta3',
  kind: 'Template',
  metadata: { name: 'checkout' },
  spec: { steps: [] },
};
const call = (request: unknown) => `return await backstage.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Backstage end to end (fake Backstage)', () => {
  it('syncs the merged served specs', () => {
    expect(h.operations()).toHaveLength(41);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(h.operation('POST /api/scaffolder/v2/tasks')).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it("pages a team's components with the cursor at Read", async () => {
    allow('GET /api/catalog/entities/by-query', 'read');
    const r = await h.execute(
      `const q = { filter: 'kind=component', limit: 1 };
       const first = await backstage.request({ path: '/api/catalog/entities/by-query', query: q });
       const next = await backstage.request({ path: '/api/catalog/entities/by-query',
         query: { ...q, cursor: first.pageInfo.nextCursor } });
       return [first.items[0].metadata.name, next.items[0].metadata.name, first.totalItems];`,
    );
    expect(r).toMatchObject({ ok: true, value: ['petstore', 'billing', 2] });
  });

  it('validates a template at Read', async () => {
    allow('POST /api/catalog/validate-entity', 'read');
    const r = await h.execute(
      call({
        method: 'POST',
        path: '/api/catalog/validate-entity',
        body: { location: 'url:https://example.com/template.yaml', entity: TEMPLATE },
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('needs a human for a dry-run, whose files can carry the Backstage token', async () => {
    const dryRunSecret = 'gho_dry-run-secret-444444';
    const request = {
      method: 'POST',
      path: '/api/scaffolder/v2/dry-run',
      body: {
        template: TEMPLATE,
        values: { name: 'checkout' },
        secrets: { USER_OAUTH_TOKEN: dryRunSecret },
        directoryContents: [],
      },
    };
    const before = fake.requests.filter((r) => r.path === request.path).length;
    allow('POST /api/scaffolder/v2/dry-run', 'read');
    await expect(h.execute(call(request))).resolves.toMatchObject({ ok: false });
    expect(fake.requests.filter((r) => r.path === request.path)).toHaveLength(before);

    allow('POST /api/scaffolder/v2/dry-run', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `const run = await backstage.request(${JSON.stringify(request)});
       return run.directoryContents[0].base64Content;`,
      {
        onApproval: (a) => {
          shown.push(a.message, JSON.stringify(a.pending));
          a.approve();
        },
      },
    );
    expect(shown).toHaveLength(2);
    expect(shown.join('\n')).not.toContain(dryRunSecret);
    expect(r).toMatchObject({ ok: true, value: Buffer.from(SECRETS.backstageToken).toString('base64') });
    expect(JSON.stringify(h.audit({ operationKey: 'POST /api/scaffolder/v2/dry-run' }))).not.toContain(dryRunSecret);
  });

  it('reports an invalid entity as INVALID_PARAMS', async () => {
    allow('POST /api/catalog/validate-entity', 'read');
    await expect(
      h.execute(
        call({
          method: 'POST',
          path: '/api/catalog/validate-entity',
          body: { location: 'url:x', entity: { kind: 'Template' } },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('refreshes an entity once a human approves it at Ask', async () => {
    allow('POST /api/catalog/refresh', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      call({ method: 'POST', path: '/api/catalog/refresh', body: { entityRef: 'component:default/petstore' } }),
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(shown[0]).toContain('component:default/petstore');
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, request, confirm, shows }) => {
      h.setOperationLevel(key, 'ask');
      await expect(h.execute(call(request))).resolves.toMatchObject({ ok: false });
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(request), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message, JSON.stringify(a.pending));
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      // The approver sees where the call reaches, and never a secret.
      expect(shown[0]).toContain(shows);
      for (const secret of [SCAFFOLD_SECRET, RETRY_SECRET]) expect(shown.join('\n')).not.toContain(secret);
    });
  });

  describe('secrets stay masked', () => {
    it('in a task result', async () => {
      allow('GET /api/scaffolder/v2/tasks/{taskId}', 'read');
      const r = await h.execute(call({ path: `/api/scaffolder/v2/tasks/${TASK_ID}` }));
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain(SECRETS.taskSecret);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    });

    it('in the audit log of a scaffold run', async () => {
      h.setOperationLevel('POST /api/scaffolder/v2/tasks', 'ask');
      const r = await h.execute(call(LOCK_CASES.find((c) => c.key === 'POST /api/scaffolder/v2/tasks')!.request), {
        onApproval: (a) => a.approve('template:default/react-app'),
      });
      h.setOperationLevel('POST /api/scaffolder/v2/tasks', null);
      expect(r).toMatchObject({ ok: true, value: { id: 'task-0002' } });
      expect(JSON.stringify(h.audit({ operationKey: 'POST /api/scaffolder/v2/tasks' }))).not.toContain(SCAFFOLD_SECRET);
    });
  });

  it('reports a Backstage denial as UPSTREAM_DENIED', async () => {
    allow('GET /api/catalog/locations', 'read');
    fake.denied.add('/api/catalog/locations');
    await expect(h.execute(call({ path: '/api/catalog/locations' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/catalog/locations');
  });

  it('reports a rejected token and an unreachable Backstage cleanly', async () => {
    await expect(h.testConnection({ baseUrl: fake.url, token: 'wrong' })).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', token: 't' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /api/catalog/locations', code: call({ path: '/api/catalog/locations' }) },
        write: {
          key: 'POST /api/catalog/refresh',
          code: call({
            method: 'POST',
            path: '/api/catalog/refresh',
            body: { entityRef: 'component:default/petstore' },
          }),
        },
        locked: {
          key: 'DELETE /api/catalog/locations/{id}',
          code: call({ method: 'DELETE', path: `/api/catalog/locations/${LOCATION_ID}` }),
          confirm: 'https://github.com/acme/catalog/blob/main/catalog-info.yaml',
        },
        secrets: { code: call({ path: `/api/scaffolder/v2/tasks/${TASK_ID}` }), values: [SECRETS.taskSecret] },
      }),
    ).toEqual([]);
    expect(fake.locations.has(LOCATION_ID)).toBe(false);
  });
});
