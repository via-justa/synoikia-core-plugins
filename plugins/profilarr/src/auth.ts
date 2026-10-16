import { requireString } from '@synoikia/plugin-sdk';
import type { InitParams } from '@synoikia/plugin-sdk';

/** Authenticates every request with the connection's API key. */
export function authHeaders({ secrets }: InitParams): () => Record<string, string> {
  const apiKey = requireString(secrets, 'apiKey');
  return () => ({ 'x-api-key': apiKey });
}
