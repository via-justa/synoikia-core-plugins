import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Mealie: the pinned v3.28.0 spec at /openapi.json, bearer auth on /api, the endpoints the tests
 * call, and responses holding secrets that must never reach the sandbox. */

export const FAKE_TOKEN = 'fake-mealie-api-token-abcdef';
export const CREDENTIALS = { token: FAKE_TOKEN };

export const SPEC_TEXT = readFileSync(new URL('./fixtures/mealie-openapi.json', import.meta.url), 'utf8');

/** Secrets the fake returns: a created API token, a password-reset token, the database URL, a webhook URL. */
export const SECRETS = {
  apiToken: 'created-api-token-111111',
  resetToken: 'password-reset-token-222222',
  dbUrl: 'postgresql://mealie:db-password-333333@postgres:5432/mealie',
  webhookUrl: 'https://ha.example/api/webhook/hook-secret-444444',
  inviteToken: 'invite-token-555555',
};

export interface FakeMealie extends FakeHttp {
  users: Map<string, { id: string; username: string; email: string }>;
  recipes: Map<string, { id: string; slug: string; name: string }>;
  /** Paths answered 403, as for a user without the permission. */
  denied: Set<string>;
  /** Replaces what /openapi.json serves (to test validation). */
  serveSpec(spec: unknown): void;
}

const ok = (body: unknown = { message: 'ok' }): FakeResponse => ({ body });

/** Stored objects the catch-all `DELETE *` lock looks up for its literal, served for GET and DELETE. */
const STORED: Record<string, Record<string, unknown>> = {
  '/api/comments/{item_id}': { id: 'c-1', text: 'Too salty' },
  '/api/foods/{item_id}': { id: 'f-1', name: 'Flour' },
  '/api/units/{item_id}': { id: 'un-1', name: 'cup' },
  '/api/groups/labels/{item_id}': { id: 'l-1', name: 'Pantry' },
  '/api/groups/reports/{item_id}': { id: 'rp-1', name: 'Migration report' },
  '/api/households/cookbooks/{item_id}': { id: 'cb-1', name: 'Weeknight' },
  '/api/households/events/notifications/{item_id}': { id: 'n-1', name: 'Phone' },
  '/api/households/mealplans/{item_id}': { id: 1, title: 'Taco night' },
  '/api/households/mealplans/rules/{item_id}': { id: 'mr-1', day: 'monday' },
  '/api/households/recipe-actions/{item_id}': { id: 'ra-1', title: 'Open in Kitchen' },
  '/api/households/shopping/items/{item_id}': { id: 'si-1', display: '2 cups flour' },
  '/api/households/shopping/lists/{item_id}': { id: 'sl-1', name: 'Groceries' },
  '/api/households/webhooks/{item_id}': { id: 'w-1', name: 'HA', url: SECRETS.webhookUrl },
  '/api/organizers/categories/{item_id}': { id: 'cat-1', name: 'Dinner' },
  '/api/organizers/tags/{item_id}': { id: 't-1', name: 'Quick' },
  '/api/organizers/tools/{item_id}': { id: 'to-1', name: 'Wok' },
  '/api/recipes/timeline/events/{item_id}': { id: 'te-1', subject: 'Made it' },
  '/api/shared/recipes/{item_id}': { id: 'sh-1', recipe: { name: 'Pasta Fagioli' } },
};

export async function startFakeMealie(): Promise<FakeMealie> {
  let spec: unknown = JSON.parse(SPEC_TEXT);
  const users = new Map([
    ['u-1', { id: 'u-1', username: 'admin', email: 'admin@example.com' }],
    ['u-2', { id: 'u-2', username: 'alex', email: 'alex@example.com' }],
  ]);
  const recipes = new Map([['pasta', { id: 'r-1', slug: 'pasta', name: 'Pasta Fagioli' }]]);
  const denied = new Set<string>();
  const groups = new Map([['g-1', { id: 'g-1', name: 'Home', slug: 'home', webhooks: [{ url: SECRETS.webhookUrl }] }]]);
  const households = new Map([['h-1', { id: 'h-1', name: 'Family', slug: 'family', groupId: 'g-1' }]]);
  const userById = (req: FakeRequest) => {
    const user = users.get(req.params.item_id ?? '');
    return user ? ok(user) : { status: 404, body: { detail: 'User not found' } };
  };

  const fake = await startFakeHttp({
    // Mealie serves its spec and /api/app/about without a token.
    guard: (req) => {
      if (req.path === '/openapi.json' || req.path === '/api/app/about') return undefined;
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return { status: 401, body: { detail: 'Not authenticated' } };
      return denied.has(req.path) ? { status: 403, body: { detail: 'Forbidden' } } : undefined;
    },
    routes: {
      ...Object.fromEntries(
        Object.entries(STORED).flatMap(([path, row]) => [
          [`GET ${path}`, () => ok(row)],
          [`DELETE ${path}`, () => ok(row)],
        ]),
      ),
      'DELETE /api/recipes/{slug}': (req) => {
        const recipe = recipes.get(req.params.slug ?? '');
        if (!recipe) return { status: 404, body: { detail: 'Recipe not found' } };
        recipes.delete(recipe.slug);
        return ok(recipe);
      },
      'DELETE /api/recipes/{slug}/image': () => ok(),
      'DELETE /api/users/{id}/favorites/{slug}': () => ok(),
      'DELETE /api/households/shopping/items': () => ok({ deletedItems: [] }),
      'GET /openapi.json': () => ok(spec),
      'GET /api/app/about': () => ok({ version: 'v3.28.0', production: true, allowSignup: false }),
      'GET /api/admin/about': () => ok({ version: 'v3.28.0', dbType: 'postgres', dbUrl: SECRETS.dbUrl }),
      'GET /api/users/self': () => ok({ id: 'u-1', username: 'admin', email: 'admin@example.com', admin: true }),
      'GET /api/groups/self': () => ok({ id: 'g-1', name: 'Home', slug: 'home' }),
      'GET /api/groups/members/{username_or_id}': (req) => {
        const user = users.get(req.params.username_or_id ?? '');
        return user ? ok(user) : { status: 404, body: { detail: 'Not found' } };
      },
      'GET /api/recipes': (req) => {
        const search = (req.query.get('search') ?? '').toLowerCase();
        const items = [...recipes.values()].filter((r) => r.name.toLowerCase().includes(search));
        return ok({ page: 1, per_page: 50, total: items.length, total_pages: 1, items });
      },
      'GET /api/recipes/{slug}': (req) => {
        const recipe = recipes.get(req.params.slug ?? '');
        return recipe ? ok(recipe) : { status: 404, body: { detail: 'Recipe not found' } };
      },
      'POST /api/recipes/create/url': () => {
        recipes.set('ramen', { id: 'r-2', slug: 'ramen', name: 'Ramen' });
        return { status: 201, body: '"ramen"', headers: { 'content-type': 'application/json' } };
      },
      'POST /api/households/shopping/items': (req) => ok({ createdItems: [req.body], updatedItems: [] }),
      'GET /api/households/webhooks': () =>
        ok({ page: 1, items: [{ id: 'w-1', name: 'Home Assistant', url: SECRETS.webhookUrl }] }),
      'GET /api/households/invitations': () => ok([{ token: SECRETS.inviteToken, usesLeft: 1 }]),
      'GET /api/admin/users/{item_id}': userById,
      'PUT /api/admin/users/{item_id}': userById,
      'DELETE /api/admin/users/{item_id}': (req) => {
        const res = userById(req);
        users.delete(req.params.item_id ?? '');
        return res;
      },
      'POST /api/admin/users': (req) => ok(req.body),
      'POST /api/admin/users/unlock': () => ok({ unlocked: 0 }),
      'POST /api/admin/users/password-reset-token': () => ok({ token: SECRETS.resetToken }),
      'GET /api/admin/groups/{item_id}': (req) => ok(groups.get(req.params.item_id ?? '')),
      'POST /api/admin/groups': (req) => ok(req.body),
      'PUT /api/admin/groups/{item_id}': (req) => ok(groups.get(req.params.item_id ?? '')),
      'DELETE /api/admin/groups/{item_id}': (req) => ok(groups.get(req.params.item_id ?? '')),
      'GET /api/admin/households/{item_id}': (req) => ok(households.get(req.params.item_id ?? '')),
      'POST /api/admin/households': (req) => ok(req.body),
      'PUT /api/admin/households/{item_id}': (req) => ok(households.get(req.params.item_id ?? '')),
      'DELETE /api/admin/households/{item_id}': (req) => ok(households.get(req.params.item_id ?? '')),
      'POST /api/admin/groups/{group_id}/ai-providers/providers': () => ok({ id: 'p-1', name: 'OpenAI' }),
      'PUT /api/admin/groups/{group_id}/ai-providers/providers/{provider_id}': () => ok({ id: 'p-1' }),
      'DELETE /api/admin/groups/{group_id}/ai-providers/providers/{provider_id}': () => ok({ id: 'p-1' }),
      'POST /api/admin/backups/{file_name}/restore': () => ok(),
      'DELETE /api/admin/backups/{file_name}': () => ok(),
      'POST /api/admin/maintenance/clean/images': () => ok(),
      'POST /api/admin/maintenance/clean/temp': () => ok(),
      'POST /api/admin/maintenance/clean/recipe-folders': () => ok(),
      'POST /api/admin/email': () => ok({ success: true }),
      'POST /api/recipes/bulk-actions/delete': (req) => {
        const slugs = (req.body as { recipes?: unknown } | undefined)?.recipes;
        if (Array.isArray(slugs)) for (const s of slugs) recipes.delete(String(s));
        return ok();
      },
      'DELETE /api/recipes/bulk-actions/export/purge': () => ok(),
      'POST /api/users/api-tokens': (req) =>
        ok({ id: 7, name: (req.body as { name?: unknown } | undefined)?.name, token: SECRETS.apiToken }),
      'DELETE /api/users/api-tokens/{token_id}': () => ok({ tokenDelete: 'deleted' }),
      'PUT /api/users/password': () => ok(),
      'POST /api/users/reset-password': () => ok(),
      'PUT /api/users/{item_id}': (req) => ok(req.body),
      'PUT /api/households/permissions': () => ok(users.get('u-2')),
      'POST /api/households/invitations': () => ok({ token: SECRETS.inviteToken, usesLeft: 1 }),
      'POST /api/households/invitations/email': () => ok({ success: true }),
      'POST /api/groups/ai-providers/providers': () => ok({ id: 'p-1', name: 'OpenAI' }),
      'PUT /api/groups/ai-providers/providers/{provider_id}': () => ok({ id: 'p-1', name: 'OpenAI' }),
      'DELETE /api/groups/ai-providers/providers/{provider_id}': () => ok({ id: 'p-1' }),
      'POST /api/households/webhooks': (req) => ok({ id: 'w-2', ...(req.body as object) }),
      'PUT /api/households/webhooks/{item_id}': (req) => ok({ id: req.params.item_id, ...(req.body as object) }),
      'PUT /api/groups/preferences': (req) => ok(req.body),
      'PUT /api/households/preferences': (req) => ok(req.body),
    },
  });
  return {
    ...fake,
    users,
    recipes,
    denied,
    serveSpec: (next) => {
      spec = next;
    },
  };
}
