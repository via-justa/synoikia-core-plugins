import { maskSensitiveResult } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJenkinsPlugin } from '../src/plugin.js';
import { CONTEXT, CREDENTIALS, DEPLOY, HELLO, startFakeJenkins } from './fake-jenkins.js';
import type { FakeJenkins } from './fake-jenkins.js';
import { LOCK_CASES } from './locks.js';

/** Golden record of what the plugin tells core (descriptors, summaries and literals of writes, result
 * masking): review snapshot diffs as security changes. */

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

const plugin = createJenkinsPlugin();
let fake: FakeJenkins;
let operations: OperationDescriptor[];
const context = { callId: 'golden', deadlineMs: 5000 };

beforeAll(async () => {
  fake = await startFakeJenkins();
  await plugin.init({
    instanceId: 'jenkins',
    config: { baseUrl: `${fake.url}${CONTEXT}`, username: CREDENTIALS.username },
    secrets: { token: CREDENTIALS.token },
    sdkVersion: '1.0.0',
  });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
beforeEach(() => fake.reset());
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

describe('Jenkins golden record', () => {
  it('catalog: every declared descriptor', async () => {
    await expect(stable(operations)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries, targets and confirm literals of writes', async () => {
    const cases = [
      ...LOCK_CASES.map((c) => ({ key: c.call, params: c.params })),
      { key: 'builds.trigger', params: { path: { job: DEPLOY }, query: { BRANCH: 'release/1.2' } } },
      { key: 'builds.trigger', params: { path: { job: HELLO } } },
      { key: 'builds.stop', params: { path: { job: DEPLOY, number: 42 } } },
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

  it('results with password parameters, as core receives them', async () => {
    const calls = [
      { key: 'jobs.get', params: { path: { job: DEPLOY } } },
      { key: 'builds.get', params: { path: { job: DEPLOY, number: 41 } } },
    ];
    const out: Record<string, unknown> = {};
    for (const c of calls) {
      const { key, params } = await plugin.resolveOperation({ fn: 'call', args: [c.key, c.params] });
      const result = await plugin.invoke({ key, params, context });
      const descriptor = operations.find((o) => o.key === key);
      out[key] = maskSensitiveResult(result, descriptor?.sensitiveResult);
    }
    // Hosts and ports of the fake vary per run.
    await expect(stable(out).replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://jenkins')).toMatchFileSnapshot(
      '__golden__/masked.json',
    );
  });
});
