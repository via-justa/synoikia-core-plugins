import { isPlainObject, readPointer, stringOr, truncate } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';
import { safe } from './summary.js';

/** Longest target description. */
const MAX_NAME = 400;

type Get = (path: string, query?: Record<string, unknown>) => Promise<unknown>;

const text = (v: unknown) => {
  const s = stringOr(v);
  return s === undefined ? undefined : safe(s);
};
const describe = (name: string, details: (string | undefined)[], separator = ', ') => {
  const shown = details.filter(Boolean).join(separator);
  return truncate(shown ? `${name} (${shown})` : name, MAX_NAME);
};

/** `stack-1 (Stack One, https://stack-1.grafana.net, region prod-us-east-0)`. */
function stack(row: unknown, id: string): ResolvedTarget | undefined {
  if (!isPlainObject(row)) return undefined;
  const region = text(row.regionSlug) ?? text(row.region);
  return {
    kind: 'stack',
    id,
    name: describe(text(row.slug) ?? safe(id), [text(row.name), text(row.url), region && `region ${region}`]),
  };
}

/** `readers (scopes: metrics:read, logs:read; realms: stack 123 {env="prod"})`: the privileges it grants. */
function accessPolicy(row: unknown, id: string): ResolvedTarget {
  if (!isPlainObject(row)) return { kind: 'accesspolicy', id, name: safe(id) };
  const scopes = Array.isArray(row.scopes) ? row.scopes.map(text).filter(Boolean) : [];
  const realms = (Array.isArray(row.realms) ? row.realms : []).filter(isPlainObject).map((r) => {
    const labels = (Array.isArray(r.labelPolicies) ? r.labelPolicies : [])
      .map((l) => text(readPointer(l, '/selector')))
      .filter(Boolean);
    return `${text(r.type) ?? '?'} ${text(r.identifier) ?? '?'}${labels.length ? ` ${labels.join(' ')}` : ''}`;
  });
  return {
    kind: 'accesspolicy',
    id,
    name: describe(
      text(row.name) ?? safe(id),
      [`scopes: ${scopes.join(', ') || 'none'}`, `realms: ${realms.join(', ') || 'none'}`],
      '; ',
    ),
  };
}

function token(row: unknown, id: string): ResolvedTarget | undefined {
  if (!isPlainObject(row)) return undefined;
  const policy = text(row.accessPolicyId);
  const expires = text(row.expiresAt);
  return {
    kind: 'token',
    id,
    name: describe(text(row.name) ?? safe(id), [
      policy && `access policy ${policy}`,
      expires ? `expires ${expires}` : 'no expiry',
    ]),
  };
}

/** What a non-GET call acts on, read from grafana.com: the stack (slug, URL, region), the access policy with
 * its scopes and realms (also for a new token, which takes them), or the token. Unreadable records are left
 * out, but for an access policy, named by its id. */
export async function resolveTargets(
  client: HttpJsonClient,
  key: string,
  params: unknown,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  if (key.startsWith('GET ')) return [];
  const p = isPlainObject(params) ? params : {};
  const path = isPlainObject(p.path) ? p.path : {};
  const region = stringOr(isPlainObject(p.query) ? p.query.region : undefined);
  const get: Get = async (url, query) => {
    try {
      return await client.request('GET', url, { timeoutMs, ...(query ? { query } : {}) });
    } catch {
      return undefined;
    }
  };
  const enc = encodeURIComponent;
  const template = key.slice(key.indexOf(' ') + 1);

  const instanceId = stringOr(path.instanceId);
  if (template.startsWith('/instances/{instanceId}') && instanceId) {
    const t = stack(await get(`/instances/${enc(instanceId)}`), instanceId);
    return t ? [t] : [];
  }
  const idOrSlug = stringOr(path.idOrSlug);
  if (template.startsWith('/v1/stacks/{idOrSlug}') && idOrSlug) {
    const t = stack(await get(`/v1/stacks/${enc(idOrSlug)}`), idOrSlug);
    return t ? [t] : [];
  }
  const policyId =
    template === '/v1/accesspolicies/{id}'
      ? stringOr(path.id)
      : template === '/v1/tokens'
        ? stringOr(readPointer(p.body, '/accessPolicyId'))
        : undefined;
  if (policyId)
    return [accessPolicy(region ? await get(`/v1/accesspolicies/${enc(policyId)}`, { region }) : undefined, policyId)];
  const tokenId = stringOr(path.id);
  if (template === '/v1/tokens/{id}' && tokenId && region) {
    const t = token(await get(`/v1/tokens/${enc(tokenId)}`, { region }), tokenId);
    return t ? [t] : [];
  }
  return [];
}
