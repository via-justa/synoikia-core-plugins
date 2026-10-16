import { requireString } from '@synoikia/plugin-sdk';
import type { InitParams } from '@synoikia/plugin-sdk';

/** Authenticates every request with the connection's API token. */
export function authHeaders({ secrets }: InitParams): () => Record<string, string> {
  const token = requireString(secrets, 'token');
  return () => ({ authorization: `Bearer ${token}` });
}
