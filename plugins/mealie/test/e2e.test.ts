import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, SECRETS, startFakeMealie } from './fake-mealie.js';
import type { FakeMealie } from './fake-mealie.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Mealie, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALEX = { id: 'u-2', username: 'alex', email: 'alex@example.com' };

let h: PluginHarness;
let fake: FakeMealie;

beforeAll(async () => {
  fake = await startFakeMealie();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  // One run per lock and secret case: more than the default per-minute caps allow.
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

const call = (request: unknown) => `return await mealie.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Mealie end to end (fake Mealie)', () => {
  it('syncs the served spec for the instance version', () => {
    expect(h.operations()).toHaveLength(235);
    expect(h.instance()).toMatchObject({ upstreamVersion: 'v3.28.0', lastSyncStatus: 'ok' });
    expect(h.operation('POST /api/admin/backups/{file_name}/restore')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('hands instructions.md to core for the MCP server instructions', () => {
    // The harness has no MCP endpoint; this is the text core wraps in <plugin-notes> (core design §2.2).
    const text = readFileSync(path.join(PLUGIN_DIR, 'instructions.md'), 'utf8').trim();
    expect(h.manifest.instructions).toBe('instructions.md');
    expect(h.ctx.instances.runtime(h.instanceId).instructions).toBe(text);
  });

  it('finds a recipe by search, then reads it by slug, at Read', async () => {
    allow('GET /api/recipes', 'read');
    const r = await h.execute(
      `const page = await mealie.request({ path: '/api/recipes', query: { search: 'pasta', perPage: 10 } });
       return (await mealie.request({ path: '/api/recipes/' + page.items[0].slug })).name;`,
    );
    expect(r).toMatchObject({ ok: true, value: 'Pasta Fagioli' });
  });

  it('imports a recipe from a URL once a human approves it at Ask', async () => {
    allow('POST /api/recipes/create/url', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      call({ method: 'POST', path: '/api/recipes/create/url', body: { url: 'https://x.example/ramen' } }),
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: 'ramen' });
    expect(shown[0]).toContain('Mealie POST /api/recipes/create/url {"url":"https://x.example/ramen"}');
  });

  describe('every locked operation needs its literal typed', () => {
    beforeEach(() => {
      fake.users.set(ALEX.id, { ...ALEX });
      fake.recipes.set('pasta', { id: 'r-1', slug: 'pasta', name: 'Pasta Fagioli' });
    });

    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, request, confirm }) => {
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
      // Where a provider or webhook sends data stays visible to the approver.
      const body = request.body as { baseUrl?: string; url?: string } | undefined;
      for (const dest of [body?.baseUrl, body?.url]) if (dest) expect(shown[0]).toContain(dest);
      // Passwords, keys and tokens in the call never reach the approver.
      for (const secret of [
        'pw-123456',
        'sk-ai-key-666666',
        'old-pw-777777',
        'new-pw-888888',
        'reset-999999',
        'pw-000000',
      ])
        expect(shown.join('\n')).not.toContain(secret);
    });
  });

  describe('secrets in results stay masked', () => {
    it.each([
      ['GET /api/admin/about', { path: '/api/admin/about' }, SECRETS.dbUrl],
      ['GET /api/households/webhooks', { path: '/api/households/webhooks' }, 'hook-secret-444444'],
      ['GET /api/households/invitations', { path: '/api/households/invitations' }, SECRETS.inviteToken],
    ])('%s', async (key, request, secret) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    });

    it.each([
      [
        'POST /api/users/api-tokens',
        { method: 'POST', path: '/api/users/api-tokens', body: { name: 'scripts' } },
        'scripts',
        SECRETS.apiToken,
      ],
      [
        'POST /api/admin/users/password-reset-token',
        { method: 'POST', path: '/api/admin/users/password-reset-token', body: { email: 'alex@example.com' } },
        'alex@example.com',
        SECRETS.resetToken,
      ],
    ])('%s (locked) returns its token masked', async (key, request, confirm, secret) => {
      h.setOperationLevel(key, 'ask');
      const r = await h.execute(call(request), { onApproval: (a) => a.approve(confirm) });
      h.setOperationLevel(key, null);
      expect(r).toMatchObject({ ok: true, value: { token: '[REDACTED]' } });
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain(secret);
    });

    it('keeps password params out of the audit log', () => {
      const audit = JSON.stringify(h.audit({ operationKey: 'PUT /api/users/password' }));
      expect(audit).not.toBe('[]');
      expect(audit).not.toContain('old-pw-777777');
      expect(audit).not.toContain('new-pw-888888');
    });
  });

  it('reports a Mealie permission denial as UPSTREAM_DENIED', async () => {
    allow('GET /api/admin/about', 'read');
    fake.denied.add('/api/admin/about');
    await expect(h.execute(call({ path: '/api/admin/about' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/admin/about');
  });

  it('reports a rejected token and an unreachable Mealie cleanly', async () => {
    await expect(h.testConnection({ baseUrl: fake.url, token: 'wrong' })).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', token: 't' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    fake.users.set(ALEX.id, { ...ALEX });
    fake.recipes.set('pasta', { id: 'r-1', slug: 'pasta', name: 'Pasta Fagioli' });
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /api/recipes/{slug}', code: call({ path: '/api/recipes/pasta' }) },
        write: {
          key: 'POST /api/households/shopping/items',
          code: call({
            method: 'POST',
            path: '/api/households/shopping/items',
            body: { shoppingListId: 'l-1', note: 'milk' },
          }),
        },
        locked: {
          key: 'DELETE /api/admin/users/{item_id}',
          code: call({ method: 'DELETE', path: '/api/admin/users/u-2' }),
          confirm: 'alex',
        },
        secrets: { code: call({ path: '/api/admin/about' }), values: [SECRETS.dbUrl] },
      }),
    ).toEqual([]);
    expect(fake.users.has('u-2')).toBe(false);
  });
});
