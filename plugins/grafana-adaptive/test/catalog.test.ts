import { readFileSync } from 'node:fs';
import { compileRules, staticCatalog } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { settings } from '../src/plugin.js';
import { LOCK_CASES } from './locks.js';

/** The declared catalog: what is locked, what reads, and that nothing outside the confirmed endpoints exists. */

const operations = staticCatalog(compileRules(settings));
const keys = new Set(operations.map((o) => o.key));
const http = (key: string) => settings.operations.find((o) => o.key === key)?.http;

describe('Grafana Adaptive catalog', () => {
  it('declares the confirmed operations only', () => {
    expect(settings.operations).toHaveLength(36);
    for (const op of settings.operations) {
      const prefix = {
        metrics: /^\/(aggregations|v1\/recommendations)\//,
        logs: /^\/adaptive-logs\//,
        traces: /^\/adaptive-traces\/api\/v1\//,
      }[op.key.split('.')[0] as 'metrics' | 'logs' | 'traces'];
      expect(op.http?.path, op.key).toMatch(prefix);
    }
  });

  it('locks exactly the keys the lock cases cover, each with a typed confirmation', () => {
    const locked = operations.filter((o) => o.locked);
    expect(locked.map((o) => o.key).sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
    for (const o of locked) expect(o).toMatchObject({ typedConfirmation: true, classification: 'write' });
  });

  it('leaves only dismissing a trace recommendation as a plain write', () => {
    expect(operations.filter((o) => o.classification === 'write' && !o.locked).map((o) => o.key)).toEqual([
      'traces.recommendations.dismiss',
    ]);
  });

  it('reads with GET, plus the rules check that only validates', () => {
    for (const o of operations)
      expect(o.classification, o.key).toBe(
        http(o.key)?.method === 'GET' || o.key === 'metrics.rules.check' ? 'read' : 'write',
      );
  });

  it('locks a write a later version declares with a known verb', () => {
    const rules = compileRules(settings);
    for (const key of ['metrics.segments.delete', 'logs.segments.create', 'traces.policies.replace'])
      expect(rules.decorate({ key, kind: 'command', group: 'x', classification: 'write' })).toMatchObject({
        locked: true,
      });
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:metrics|logs|traces)\.[A-Za-z.]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const key of named) expect(keys, key).toContain(key);
  });
});
