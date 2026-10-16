import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGrafanaAdaptivePlugin } from '../src/plugin.js';
import { startFakeAdaptive, TOKEN } from './fake-adaptive.js';
import type { FakeAdaptive } from './fake-adaptive.js';
import { LOCK_CASES } from './locks.js';

/** Golden record of what the plugin tells core (descriptors, and the targets, summaries and literals of writes):
 * review snapshot diffs as security changes. */

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

const plugin = createGrafanaAdaptivePlugin();
let fake: FakeAdaptive;
let operations: OperationDescriptor[];

beforeAll(async () => {
  fake = await startFakeAdaptive();
  await plugin.init({
    instanceId: 'adaptive',
    config: fake.connection(),
    secrets: { token: TOKEN },
    sdkVersion: '1.0.0',
  });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
beforeEach(() => fake.reset());
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

describe('Grafana Adaptive golden record', () => {
  it('catalog: every declared descriptor', async () => {
    await expect(stable(operations)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries, targets and confirm literals of writes', async () => {
    const cases = [
      ...LOCK_CASES.map((c) => ({ key: c.key, params: c.params })),
      { key: 'traces.recommendations.dismiss', params: { path: { id: 'rec-1' } } },
      { key: 'metrics.rules.replace', params: { ifMatch: '"v1"', query: { segment: 'seg-1' }, body: [] } },
      {
        key: 'metrics.rules.replace',
        params: {
          ifMatch: '"v1"',
          body: [
            { metric: 'http_requests_total', match_type: 'prefix', drop_labels: ['pod'] },
            { metric: 'debug_', match_type: 'prefix', drop: true },
          ],
        },
      },
    ];
    const out: Record<string, unknown> = {};
    for (const [i, c] of cases.entries()) {
      const { key, params } = await plugin.resolveOperation({ fn: 'call', args: [c.key, c.params] });
      const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
      out[`${String(i).padStart(2, '0')} ${c.key}`] = {
        targets,
        ...(await plugin.summarize({ key, params, targets })),
      };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });
});
