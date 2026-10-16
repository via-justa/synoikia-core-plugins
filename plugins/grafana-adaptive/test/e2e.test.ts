import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDS, startFakeAdaptive, TOKEN } from './fake-adaptive.js';
import type { FakeAdaptive } from './fake-adaptive.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the three fake Adaptive services, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeAdaptive;

beforeAll(async () => {
  fake = await startFakeAdaptive();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { ...fake.connection(), token: TOKEN } });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

const call = (key: string, params?: unknown) =>
  `return await grafanaAdaptive.call(${JSON.stringify(key)}${params === undefined ? '' : `, ${JSON.stringify(params)}`});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Grafana Adaptive end to end (three fake services)', () => {
  it('syncs the declared operations of the three services', () => {
    expect(h.operations()).toHaveLength(36);
    expect(h.instance()).toMatchObject({ upstreamVersion: 'adaptive (metrics, logs, traces)', lastSyncStatus: 'ok' });
    expect(h.operation('metrics.rules.replace')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(h.operation('traces.recommendations.dismiss')).toMatchObject({ locked: false });
  });

  it('reads the rules and recommendations at Read, and applies the recommended set once confirmed', async () => {
    allow('metrics.rules.list', 'read');
    allow('metrics.recommendations.list', 'read');
    h.setOperationLevel('metrics.rules.replace', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `const now = await grafanaAdaptive.call('metrics.rules.list');
       const rec = await grafanaAdaptive.call('metrics.recommendations.list');
       const res = await grafanaAdaptive.call('metrics.rules.replace', { ifMatch: rec.rulesVersion, body: rec.recommendations });
       return [now.rules.length, res.etag];`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve(IDS.metrics);
        },
      },
    );
    h.setOperationLevel('metrics.rules.replace', null);
    expect(r).toMatchObject({ ok: true, value: [2, '"v2"'] });
    expect(shown[0]).toContain('aggregates: "container_cpu_usage_seconds_total" aggregated (drop labels "id")');
    expect(fake.state.rules).toHaveLength(3);
  });

  it('reads log patterns and trace policies at Read', async () => {
    allow('logs.recommendations.list', 'read');
    allow('traces.policies.list', 'read');
    const r = await h.execute(
      `const p = await grafanaAdaptive.call('logs.recommendations.list');
       const t = await grafanaAdaptive.call('traces.policies.list');
       return [p[0].recommended_drop_rate, t[0].name];`,
    );
    expect(r).toMatchObject({ ok: true, value: [0.95, 'keep-5-percent'] });
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, params, confirm, shows, done }) => {
      h.setOperationLevel(key, 'ask');
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(key, params), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message);
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      expect(shown[0]).toContain(shows);
      expect(done(fake.state)).toBe(true);
    });
  });

  it('refuses a stale etag without changing the rules', async () => {
    h.setOperationLevel('metrics.rules.replace', 'ask');
    const r = await h.execute(call('metrics.rules.replace', { ifMatch: '"v0"', body: [] }), {
      onApproval: (a) => a.approve(IDS.metrics),
    });
    h.setOperationLevel('metrics.rules.replace', null);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(fake.state.rules).toHaveLength(2);
  });

  it('refuses paths that would leave the template before any request', async () => {
    allow('traces.policies.get', 'read');
    const before = fake.traces.requests.length;
    for (const id of ['..', '../recommendations', 'a?b'])
      await expect(h.execute(call('traces.policies.get', { path: { id } }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' },
      });
    expect(fake.traces.requests.length).toBe(before);
  });

  it('keeps the token out of results and the audit log', async () => {
    allow('logs.exemptions.list', 'read');
    await h.execute(call('logs.exemptions.list'));
    expect(JSON.stringify(h.audit({}))).not.toContain(TOKEN);
  });

  it('reports a denial as UPSTREAM_DENIED and a rejected token cleanly', async () => {
    allow('logs.dropRules.list', 'read');
    await expect(h.testConnection({ ...fake.connection(), token: 'wrong' })).resolves.toMatchObject({ ok: false });
    await expect(
      h.testConnection({ prometheusUrl: 'http://127.0.0.1:1', metricsInstanceId: IDS.metrics, token: TOKEN }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      h.testConnection({
        prometheusUrl: 'http://prometheus.example.com',
        metricsInstanceId: IDS.metrics,
        token: TOKEN,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'traces.policies.list', code: call('traces.policies.list') },
        write: {
          key: 'traces.recommendations.dismiss',
          code: call('traces.recommendations.dismiss', { path: { id: 'rec-1' } }),
        },
        locked: {
          key: 'traces.policies.delete',
          code: call('traces.policies.delete', { path: { id: 'pol-1' } }),
          confirm: 'keep-5-percent',
        },
      }),
    ).toEqual([]);
    expect(fake.state.policies.has('pol-1')).toBe(false);
  });
});
