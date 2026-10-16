import { requireString } from '@synoikia/plugin-sdk';
import type { InitParams } from '@synoikia/plugin-sdk';

/** HTTP Basic with the user's API token, which Jenkins accepts on POSTs without a CSRF crumb. */
export function authHeaders({ config, secrets }: InitParams): () => Record<string, string> {
  const credentials = Buffer.from(`${requireString(config, 'username')}:${requireString(secrets, 'token')}`).toString(
    'base64',
  );
  return () => ({ authorization: `Basic ${credentials}` });
}
