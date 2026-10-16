import { requireString } from '@synoikia/plugin-sdk';
import type { InitParams } from '@synoikia/plugin-sdk';

/** Authenticates every request with the connection's token, and names this instance as a stable Plex client. */
export function authHeaders({ secrets, instanceId }: InitParams): () => Record<string, string> {
  const token = requireString(secrets, 'token');
  const client = `synoikia-${instanceId.replace(/[^\w.-]/g, '-')}`;
  return () => ({ 'X-Plex-Token': token, 'X-Plex-Client-Identifier': client, 'X-Plex-Product': 'Synoikia' });
}
