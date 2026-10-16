import { ORG, REGION } from './fake-grafanacloud.js';

/** One call per locked key, and the literal an approver must type for it against the fake grafana.com. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; query?: Record<string, string>; body?: unknown };
  confirm: string;
}

const lock = (
  key: string,
  path: string,
  confirm: string,
  body?: unknown,
  query?: Record<string, string>,
): LockCase => ({
  key,
  request: { method: key.split(' ')[0]!, path, ...(query ? { query } : {}), ...(body === undefined ? {} : { body }) },
  confirm,
});
const region = { region: REGION };

export const LOCK_CASES: LockCase[] = [
  lock('DELETE /instances/{instanceId}', '/instances/acme-prod', 'acme-prod'),
  lock(
    'DELETE /instances/{instanceId}/api/serviceaccounts/{serviceAccountId}',
    '/instances/acme-prod/api/serviceaccounts/5',
    'synoikia-bot',
  ),
  lock(
    'DELETE /instances/{instanceId}/api/serviceaccounts/{serviceAccountId}/tokens/{tokenId}',
    '/instances/acme-prod/api/serviceaccounts/5/tokens/9',
    'synoikia-bot',
  ),
  lock(
    'DELETE /instances/{instanceId}/plugins/{pluginSlugOrId}',
    '/instances/acme-prod/plugins/grafana-clock-panel',
    'acme-prod',
  ),
  lock('DELETE /orgs/{slugOrId}/members/{usernameOrId}', `/orgs/${ORG}/members/alex`, 'alex'),
  lock('DELETE /v1/accesspolicies/{id}', '/v1/accesspolicies/ap-1', 'stack-readers', undefined, region),
  lock('DELETE /v1/stacks/{idOrSlug}', '/v1/stacks/acme-prod', 'acme-prod'),
  lock('DELETE /v1/tokens/{id}', '/v1/tokens/tok-1', 'ci-token', undefined, region),
  lock('POST /instances', '/instances', 'acme-staging', {
    name: 'Acme Staging',
    slug: 'acme-staging',
    region: REGION,
    org: ORG,
  }),
  lock('POST /instances/{instanceId}', '/instances/101', 'acme-prod', { deleteProtection: false }),
  lock('POST /instances/{instanceId}/api/serviceaccounts', '/instances/acme-prod/api/serviceaccounts', 'acme-prod', {
    name: 'ci',
    role: 'Admin',
  }),
  lock(
    'POST /instances/{instanceId}/api/serviceaccounts/{serviceAccountId}/tokens',
    '/instances/acme-prod/api/serviceaccounts/5/tokens',
    'synoikia-bot',
    { name: 'ci', secondsToLive: 3600 },
  ),
  lock('POST /instances/{instanceId}/plugins', '/instances/acme-prod/plugins', 'acme-prod', {
    plugin: 'grafana-clock-panel',
    version: '2.1.5',
  }),
  lock(
    'POST /instances/{instanceId}/plugins/{pluginSlugOrId}',
    '/instances/acme-prod/plugins/grafana-clock-panel',
    'acme-prod',
    { version: '2.2.0' },
  ),
  lock('POST /orgs/{slugOrId}/members', '/orgs/7/members', ORG, { username: 'sam', role: 'Admin' }),
  lock('POST /orgs/{slugOrId}/members/{usernameOrId}', `/orgs/${ORG}/members/alex`, 'alex', { role: 'Admin' }),
  lock('POST /orgs/{slugOrId}/settings', `/orgs/${ORG}/settings`, ORG, { mfaRequired: false }),
  lock(
    'POST /v1/accesspolicies',
    '/v1/accesspolicies',
    'org-writers',
    { name: 'org-writers', scopes: ['metrics:write', 'stacks:write'], realms: [{ type: 'org', identifier: '7' }] },
    region,
  ),
  lock(
    'POST /v1/accesspolicies/{id}',
    '/v1/accesspolicies/ap-1',
    'stack-readers',
    { scopes: ['metrics:read', 'accesspolicies:write'] },
    region,
  ),
  lock('POST /v1/stacks', '/v1/stacks', 'acme-dev', { slug: 'acme-dev', name: 'Acme Dev', region: REGION, org: ORG }),
  lock('POST /v1/stacks/{idOrSlug}', '/v1/stacks/acme-prod', 'acme-prod', { deleteProtection: false }),
  lock('POST /v1/tokens', '/v1/tokens', 'stack-readers', { name: 'ci', accessPolicyId: 'ap-1' }, region),
  lock('POST /v1/tokens/{id}', '/v1/tokens/tok-1', 'ci-token', { expiresAt: '2030-01-01T00:00:00Z' }, region),
];
