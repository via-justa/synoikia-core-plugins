import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../src/catalog.js';
import { createTrueNasPlugin } from '../src/plugin.js';
import { FAKE_API_KEY, startFakeTrueNas } from './fake-truenas.js';
import type { FakeTrueNas } from './fake-truenas.js';

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

const plugin = createTrueNasPlugin();
let fake: FakeTrueNas;

beforeAll(async () => {
  fake = await startFakeTrueNas();
  await plugin.init({
    instanceId: 'nas',
    config: { baseUrl: fake.url },
    secrets: { apiKey: FAKE_API_KEY },
    sdkVersion: '1.0.0',
  });
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const PARAMS: unknown[][] = [
  [],
  ['tank/media'],
  [1],
  [70],
  [{ path: '/mnt/tank', username: 'bob', name: 'k' }],
  [1, { key: 'secret' }],
];

describe('TrueNAS golden record', () => {
  it('catalog descriptors', async () => {
    const { operations } = await plugin.syncCatalog();
    await expect(stable(operations)).toMatchFileSnapshot('__golden__/catalog.json');
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

  it('classification of known names', async () => {
    const names = [
      'system.reboot',
      'system.shutdown',
      'pool.export',
      'disk.wipe',
      'config.reset',
      'user.set_password',
      'user.delete',
      'pool.dataset.change_key',
      'pool.dataset.delete',
      'app.delete',
      'audit.config',
      'auth.generate_token',
      'auth.generate_onetime_password',
      'docker.delete_backup',
      'interface.network_config_to_be_removed',
      'user.has_local_administrator_set_up',
      'user.renew_2fa_secret',
      'user.setup_local_administrator',
      'pool.dataset.export_key',
      'api_key.create',
      'api_key.query',
      'filesystem.setacl',
      'filesystem.setacl#pool-root',
      'pool.query',
      'pool.get_instance',
      'system.info',
      'disk.list',
      'app.start',
      'pool.scrub',
      'foo.bar',
      'x.lock_y',
      'pool.dataset.create',
      'sharing.smb.update',
      'cert.choices',
      'cert.ec_curve_choices',
      'vm.get_display_web_uri',
    ];
    const roles = [undefined, ['POOL_READ'], ['POOL_WRITE'], ['READONLY_ADMIN', 'FULL_ADMIN'], ['FULL_ADMIN']];
    const out = names.map((n) => ({ n, r: roles.map((r) => classify(n, r)) }));
    await expect(stable(out)).toMatchFileSnapshot('__golden__/classify.json');
  });

  it('result masking', async () => {
    const out: Record<string, unknown> = {};
    for (const op of [
      'pool.dataset.export_key',
      'api_key.create',
      'auth.generate_token',
      'kerberos.keytab.query',
      'core.get_jobs',
      'cloudsync.credentials.query',
      'pool.query',
    ]) {
      try {
        out[op] = await plugin.invoke({
          key: op,
          params: op === 'pool.dataset.export_key' ? ['tank/secure'] : [],
          context: { callId: 'g', deadlineMs: 5000 },
        });
      } catch (err) {
        out[op] = { error: (err as Error).message };
      }
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/results.json');
  });
});
