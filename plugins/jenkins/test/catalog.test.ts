import { readFileSync } from 'node:fs';
import { compileRules, staticCatalog } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { settings } from '../src/plugin.js';
import { LOCK_CASES } from './locks.js';

/** The declared catalog: what is locked, what reads, and that nothing outside the approved set exists. */

const operations = staticCatalog(compileRules(settings));
const keys = new Set(operations.map((o) => o.key));
const http = (key: string) => settings.operations.find((o) => o.key === key)?.http;

describe('Jenkins catalog', () => {
  it('locks exactly the keys the lock cases cover, each with a typed confirmation', () => {
    const locked = operations.filter((o) => o.locked);
    expect(locked.map((o) => o.key).sort()).toEqual(LOCK_CASES.map((c) => c.key).sort());
    for (const o of locked) expect(o).toMatchObject({ typedConfirmation: true, classification: 'write' });
  });

  it('reads only with GET, and every GET reads', () => {
    for (const o of operations) expect(o.classification, o.key).toBe(http(o.key)?.method === 'GET' ? 'read' : 'write');
  });

  it('locks a delete or system action a later version adds', () => {
    const rules = compileRules(settings);
    for (const key of ['nodes.delete', 'system.restart'])
      expect(rules.decorate({ key, kind: 'command', group: 'x', classification: 'write' })).toMatchObject({
        locked: true,
      });
  });

  it('declares no script console, credentials, plugin manager, config.xml or replay path', () => {
    for (const op of settings.operations)
      expect(op.http?.path, op.key).not.toMatch(
        /script|credential|pluginManager|config\.xml|manage|replay|doRename|createItem|configSubmit/i,
      );
    expect(settings.operations).toHaveLength(17);
  });

  it('gives every read a default tree', () => {
    for (const o of operations.filter((op) => op.classification === 'read' && op.key !== 'builds.log'))
      expect(settings.plugin.trees[o.key], o.key).toBeTruthy();
    for (const key of Object.keys(settings.plugin.trees)) expect(keys).toContain(key);
  });
});

describe('instructions.md', () => {
  const text = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

  it('stays within 1.5 KB', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536);
  });

  it('names only operations the catalog has', () => {
    const named = [...text.matchAll(/`((?:jobs|builds|queue|nodes|system)\.[A-Za-z]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const key of named) expect(keys, key).toContain(key);
    for (const key of keys) if (!key.includes('#')) expect(named, key).toContain(key);
  });
});
