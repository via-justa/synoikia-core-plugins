/** One call per locked key, and the literal an approver must type for it against the fake Mealie. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

export const LOCK_CASES: LockCase[] = [
  {
    key: 'POST /api/admin/users',
    request: {
      method: 'POST',
      path: '/api/admin/users',
      body: { username: 'sam', email: 'sam@example.com', password: 'pw-123456' },
    },
    confirm: 'sam',
  },
  {
    key: 'PUT /api/admin/users/{item_id}',
    request: { method: 'PUT', path: '/api/admin/users/u-2', body: { admin: true } },
    confirm: 'alex',
  },
  {
    key: 'DELETE /api/admin/users/{item_id}',
    request: { method: 'DELETE', path: '/api/admin/users/u-2' },
    confirm: 'alex',
  },
  {
    key: 'POST /api/admin/users/unlock',
    request: { method: 'POST', path: '/api/admin/users/unlock' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/users/password-reset-token',
    request: { method: 'POST', path: '/api/admin/users/password-reset-token', body: { email: 'alex@example.com' } },
    confirm: 'alex@example.com',
  },
  {
    key: 'POST /api/admin/groups',
    request: { method: 'POST', path: '/api/admin/groups', body: { name: 'Cabin' } },
    confirm: 'Cabin',
  },
  {
    key: 'PUT /api/admin/groups/{item_id}',
    request: { method: 'PUT', path: '/api/admin/groups/g-1', body: { name: 'Home 2' } },
    confirm: 'Home',
  },
  {
    key: 'DELETE /api/admin/groups/{item_id}',
    request: { method: 'DELETE', path: '/api/admin/groups/g-1' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/households',
    request: { method: 'POST', path: '/api/admin/households', body: { groupId: 'g-1', name: 'Guests' } },
    confirm: 'Guests',
  },
  {
    key: 'PUT /api/admin/households/{item_id}',
    request: { method: 'PUT', path: '/api/admin/households/h-1', body: { name: 'Fam' } },
    confirm: 'Family',
  },
  {
    key: 'DELETE /api/admin/households/{item_id}',
    request: { method: 'DELETE', path: '/api/admin/households/h-1' },
    confirm: 'Family',
  },
  {
    key: 'POST /api/admin/groups/{group_id}/ai-providers/providers',
    request: {
      method: 'POST',
      path: '/api/admin/groups/g-1/ai-providers/providers',
      body: { name: 'OpenAI', apiKey: 'sk-ai-key-666666' },
    },
    confirm: 'Home',
  },
  {
    key: 'PUT /api/admin/groups/{group_id}/ai-providers/providers/{provider_id}',
    request: { method: 'PUT', path: '/api/admin/groups/g-1/ai-providers/providers/p-1', body: { name: 'OpenAI' } },
    confirm: 'Home',
  },
  {
    key: 'DELETE /api/admin/groups/{group_id}/ai-providers/providers/{provider_id}',
    request: { method: 'DELETE', path: '/api/admin/groups/g-1/ai-providers/providers/p-1' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/backups/{file_name}/restore',
    request: { method: 'POST', path: '/api/admin/backups/mealie_2026.10.14.zip/restore' },
    confirm: 'mealie_2026.10.14.zip',
  },
  {
    key: 'DELETE /api/admin/backups/{file_name}',
    request: { method: 'DELETE', path: '/api/admin/backups/mealie_2026.10.14.zip' },
    confirm: 'mealie_2026.10.14.zip',
  },
  {
    key: 'POST /api/admin/maintenance/clean/images',
    request: { method: 'POST', path: '/api/admin/maintenance/clean/images' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/maintenance/clean/temp',
    request: { method: 'POST', path: '/api/admin/maintenance/clean/temp' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/maintenance/clean/recipe-folders',
    request: { method: 'POST', path: '/api/admin/maintenance/clean/recipe-folders' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/admin/email',
    request: { method: 'POST', path: '/api/admin/email', body: { email: 'someone@example.com' } },
    confirm: 'someone@example.com',
  },
  {
    key: 'POST /api/recipes/bulk-actions/delete',
    request: { method: 'POST', path: '/api/recipes/bulk-actions/delete', body: { recipes: ['pasta'] } },
    confirm: 'Home',
  },
  {
    key: 'DELETE /api/recipes/bulk-actions/export/purge',
    request: { method: 'DELETE', path: '/api/recipes/bulk-actions/export/purge' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/users/api-tokens',
    request: { method: 'POST', path: '/api/users/api-tokens', body: { name: 'scripts' } },
    confirm: 'scripts',
  },
  {
    key: 'DELETE /api/users/api-tokens/{token_id}',
    request: { method: 'DELETE', path: '/api/users/api-tokens/7' },
    confirm: 'admin',
  },
  {
    key: 'PUT /api/users/password',
    request: {
      method: 'PUT',
      path: '/api/users/password',
      body: { currentPassword: 'old-pw-777777', newPassword: 'new-pw-888888' },
    },
    confirm: 'admin',
  },
  {
    key: 'POST /api/users/reset-password',
    request: {
      method: 'POST',
      path: '/api/users/reset-password',
      body: { token: 'reset-999999', email: 'alex@example.com', password: 'pw-000000', passwordConfirm: 'pw-000000' },
    },
    confirm: 'alex@example.com',
  },
  {
    key: 'PUT /api/users/{item_id}',
    request: { method: 'PUT', path: '/api/users/u-2', body: { username: 'mallory', admin: true } },
    confirm: 'alex',
  },
  {
    key: 'PUT /api/households/permissions',
    request: { method: 'PUT', path: '/api/households/permissions', body: { userId: 'u-2', canManage: true } },
    confirm: 'alex',
  },
  {
    key: 'POST /api/households/invitations',
    request: { method: 'POST', path: '/api/households/invitations', body: { uses: 1 } },
    confirm: 'Home',
  },
  {
    key: 'POST /api/households/invitations/email',
    request: {
      method: 'POST',
      path: '/api/households/invitations/email',
      body: { email: 'guest@example.com', token: 'invite-token-555555' },
    },
    confirm: 'guest@example.com',
  },
  // The approver sees where a provider or webhook sends data: baseUrl and url stay in the summary.
  {
    key: 'POST /api/groups/ai-providers/providers',
    request: {
      method: 'POST',
      path: '/api/groups/ai-providers/providers',
      body: { name: 'OpenAI', baseUrl: 'https://llm.example/v1', apiKey: 'sk-ai-key-666666' },
    },
    confirm: 'Home',
  },
  {
    key: 'PUT /api/groups/ai-providers/providers/{provider_id}',
    request: {
      method: 'PUT',
      path: '/api/groups/ai-providers/providers/p-1',
      body: {
        name: 'OpenAI',
        baseUrl: 'https://llm.example/v1',
        requestHeaders: { Authorization: 'Bearer sk-ai-key-666666' },
      },
    },
    confirm: 'Home',
  },
  {
    key: 'DELETE /api/groups/ai-providers/providers/{provider_id}',
    request: { method: 'DELETE', path: '/api/groups/ai-providers/providers/p-1' },
    confirm: 'Home',
  },
  {
    key: 'POST /api/households/webhooks',
    request: {
      method: 'POST',
      path: '/api/households/webhooks',
      body: { name: 'HA', url: 'https://ha.example/api/webhook/new-hook', enabled: true },
    },
    confirm: 'Home',
  },
  {
    key: 'PUT /api/households/webhooks/{item_id}',
    request: {
      method: 'PUT',
      path: '/api/households/webhooks/w-1',
      body: { name: 'HA', url: 'https://elsewhere.example/collect', enabled: true },
    },
    confirm: 'Home',
  },
  {
    key: 'PUT /api/groups/preferences',
    request: { method: 'PUT', path: '/api/groups/preferences', body: { privateGroup: false } },
    confirm: 'Home',
  },
  {
    key: 'PUT /api/households/preferences',
    request: { method: 'PUT', path: '/api/households/preferences', body: { privateHousehold: false } },
    confirm: 'Home',
  },
  {
    key: 'DELETE /api/comments/{item_id}',
    request: { method: 'DELETE', path: '/api/comments/c-1' },
    confirm: 'c-1',
  },
  {
    key: 'DELETE /api/foods/{item_id}',
    request: { method: 'DELETE', path: '/api/foods/f-1' },
    confirm: 'Flour',
  },
  {
    key: 'DELETE /api/units/{item_id}',
    request: { method: 'DELETE', path: '/api/units/un-1' },
    confirm: 'cup',
  },
  {
    key: 'DELETE /api/groups/labels/{item_id}',
    request: { method: 'DELETE', path: '/api/groups/labels/l-1' },
    confirm: 'Pantry',
  },
  {
    key: 'DELETE /api/groups/reports/{item_id}',
    request: { method: 'DELETE', path: '/api/groups/reports/rp-1' },
    confirm: 'Migration report',
  },
  {
    key: 'DELETE /api/households/cookbooks/{item_id}',
    request: { method: 'DELETE', path: '/api/households/cookbooks/cb-1' },
    confirm: 'Weeknight',
  },
  {
    key: 'DELETE /api/households/events/notifications/{item_id}',
    request: { method: 'DELETE', path: '/api/households/events/notifications/n-1' },
    confirm: 'Phone',
  },
  {
    key: 'DELETE /api/households/mealplans/{item_id}',
    request: { method: 'DELETE', path: '/api/households/mealplans/1' },
    confirm: 'Taco night',
  },
  {
    key: 'DELETE /api/households/mealplans/rules/{item_id}',
    request: { method: 'DELETE', path: '/api/households/mealplans/rules/mr-1' },
    confirm: 'mr-1',
  },
  {
    key: 'DELETE /api/households/recipe-actions/{item_id}',
    request: { method: 'DELETE', path: '/api/households/recipe-actions/ra-1' },
    confirm: 'Open in Kitchen',
  },
  {
    key: 'DELETE /api/households/shopping/items/{item_id}',
    request: { method: 'DELETE', path: '/api/households/shopping/items/si-1' },
    confirm: '2 cups flour',
  },
  {
    key: 'DELETE /api/households/shopping/lists/{item_id}',
    request: { method: 'DELETE', path: '/api/households/shopping/lists/sl-1' },
    confirm: 'Groceries',
  },
  {
    key: 'DELETE /api/households/webhooks/{item_id}',
    request: { method: 'DELETE', path: '/api/households/webhooks/w-1' },
    confirm: 'HA',
  },
  {
    key: 'DELETE /api/organizers/categories/{item_id}',
    request: { method: 'DELETE', path: '/api/organizers/categories/cat-1' },
    confirm: 'Dinner',
  },
  {
    key: 'DELETE /api/organizers/tags/{item_id}',
    request: { method: 'DELETE', path: '/api/organizers/tags/t-1' },
    confirm: 'Quick',
  },
  {
    key: 'DELETE /api/organizers/tools/{item_id}',
    request: { method: 'DELETE', path: '/api/organizers/tools/to-1' },
    confirm: 'Wok',
  },
  {
    key: 'DELETE /api/recipes/timeline/events/{item_id}',
    request: { method: 'DELETE', path: '/api/recipes/timeline/events/te-1' },
    confirm: 'Made it',
  },
  {
    key: 'DELETE /api/shared/recipes/{item_id}',
    request: { method: 'DELETE', path: '/api/shared/recipes/sh-1' },
    confirm: 'Pasta Fagioli',
  },
  {
    key: 'DELETE /api/recipes/{slug}',
    request: { method: 'DELETE', path: '/api/recipes/pasta' },
    confirm: 'Pasta Fagioli',
  },
  {
    key: 'DELETE /api/recipes/{slug}/image',
    request: { method: 'DELETE', path: '/api/recipes/pasta/image' },
    confirm: 'pasta',
  },
  {
    key: 'DELETE /api/users/{id}/favorites/{slug}',
    request: { method: 'DELETE', path: '/api/users/u-1/favorites/pasta' },
    confirm: 'pasta',
  },
  {
    key: 'DELETE /api/households/shopping/items',
    request: { method: 'DELETE', path: '/api/households/shopping/items', query: { ids: ['si-1', 'si-2'] } },
    confirm: 'Home',
  },
];
