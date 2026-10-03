import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog.js';
import { createHomeAssistantPlugin } from '../src/plugin.js';
import { FAKE_TOKEN, startFakeHa } from './fake-ha.js';
import type { FakeHa } from './fake-ha.js';

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

const plugin = createHomeAssistantPlugin();
let fake: FakeHa;

beforeAll(async () => {
  fake = await startFakeHa();
  await plugin.init({
    instanceId: 'ha',
    config: { baseUrl: fake.url },
    secrets: { token: FAKE_TOKEN },
    sdkVersion: '1.0.0',
  });
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

describe('Home Assistant golden record', () => {
  it('catalog descriptors', async () => {
    const { operations } = await plugin.syncCatalog();
    await expect(stable(operations)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries and confirm literals of locked operations', async () => {
    const { operations } = await plugin.syncCatalog();
    const locked = (operations as OperationDescriptor[]).filter((o) => o.locked);
    const out: Record<string, unknown> = {};
    for (const op of locked) {
      out[op.key] = await plugin.summarize({
        key: op.key,
        params: {
          id: 'a1',
          area_id: 'kitchen',
          entity_id: 'lock.front_door',
          entities: { 'lock.front_door': 'unlocked' },
        },
        targets: [],
      });
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('registry and guides', async () => {
    const entries = await plugin.syncRegistry!();
    let guide: unknown;
    try {
      guide = await plugin.getGuide!({ key: 'config/automation/config/create' });
    } catch (err) {
      guide = { error: (err as Error).message };
    }
    await expect(stable({ entries, guide })).toMatchFileSnapshot('__golden__/registry.json');
  });

  // Written out here, not read from plugin.yaml: deleting a lock or a split from plugin.yaml must show up
  // as a diff in this record, even for services the fake doesn't have.
  it('policy for every service plugin.yaml protects', async () => {
    const services = {
      lock: { unlock: {}, open: {}, lock: {} },
      alarm_control_panel: { alarm_disarm: {}, alarm_arm_away: {} },
      homeassistant: {
        restart: {},
        stop: {},
        turn_on: { target: {} },
        turn_off: { target: {} },
        toggle: { target: {} },
      },
      hassio: { host_reboot: {}, host_shutdown: {}, restore_full: {}, restore_partial: {} },
      backup: { restore: {}, create: {} },
      cover: {
        open_cover: { target: {} },
        toggle: { target: {} },
        set_cover_position: { target: {} },
        close_cover: {},
      },
      scene: { apply: {}, turn_on: { target: {} } },
      climate: { set_temperature: { target: {} } },
      light: { turn_on: { target: {} } },
    };
    const { operations } = buildCatalog(services);
    const out = operations.map(({ key, locked, classification, classificationReason, matchProfile, docs }) => ({
      key,
      locked,
      classification,
      classificationReason,
      matchProfile,
      description: docs?.description,
    }));
    await expect(stable(out)).toMatchFileSnapshot('__golden__/policy.json');
  });
});
