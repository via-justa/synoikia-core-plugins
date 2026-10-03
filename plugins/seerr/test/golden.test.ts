import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSeerrPlugin } from '../src/plugin.js';
import { FAKE_EMAIL, FAKE_PASSWORD, startFakeSeerr } from './fake-seerr.js';
import type { FakeSeerr } from './fake-seerr.js';

/**
 * Golden record of what the plugin tells core: every catalog descriptor, and the approval summary and
 * typed-confirmation literal of every locked operation. A change here changes classification, locks,
 * redaction or approvals, so review the snapshot diff as a security change.
 */

/** Stable JSON (sorted keys): property order means nothing to core. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2);
}

const plugin = createSeerrPlugin();
let fake: FakeSeerr;

beforeAll(async () => {
  fake = await startFakeSeerr();
  await plugin.init({
    instanceId: 'seerr',
    config: { baseUrl: fake.url, authMethod: 'local', email: FAKE_EMAIL, specBaseUrl: fake.specUrl },
    secrets: { password: FAKE_PASSWORD },
    sdkVersion: '1.0.0',
  });
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const PARAMS: unknown[] = [
  {},
  { path: { userId: '1', requestId: '1', radarrId: '0', sonarrId: '0', sliderId: '1', jobId: 'plex-full-scan' } },
  { path: { requestId: '2', status: 'approve' }, body: { start: true } },
];

describe('Seerr golden record', () => {
  it('catalog descriptors', async () => {
    const { operations, sourceRef } = await plugin.syncCatalog();
    await expect(stable({ sourceRef, operations })).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries and confirm literals of locked operations', async () => {
    const { operations } = await plugin.syncCatalog();
    const locked = (operations as OperationDescriptor[]).filter((o) => o.locked);
    const out: Record<string, unknown[]> = {};
    for (const op of locked) {
      out[op.key] = [];
      for (const params of PARAMS) out[op.key]!.push(await plugin.summarize({ key: op.key, params, targets: [] }));
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('resolved keys', async () => {
    const reqs = [
      { method: 'POST', path: '/request/1/approve' },
      { method: 'POST', path: '/request/2/approve' },
      { method: 'POST', path: '/settings/plex/sync', body: { start: true } },
      { method: 'POST', path: '/settings/plex/sync', body: { cancel: true } },
      { method: 'POST', path: '/settings/jellyfin/sync' },
      { method: 'POST', path: '/settings/jobs/plex-full-scan/run' },
      { method: 'POST', path: '/settings/jobs/radarr-scan/run' },
      { method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 1 } },
      { method: 'GET', path: '/api/v1/settings/discover/reset' },
    ];
    const out = [];
    for (const r of reqs) {
      try {
        out.push(await plugin.resolveOperation({ fn: 'request', args: [r] }));
      } catch (err) {
        out.push({ error: (err as Error).message });
      }
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/resolve.json');
  });
});
