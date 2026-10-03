import { OperationDescriptorSchema } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { buildCatalog, classify, groupOf, LOCKED, needsPoolRootKey } from '../src/catalog.js';
import { METHODS } from './fake-truenas.js';

describe('classify (TN §2.3, §9)', () => {
  it.each([
    ['pool.query', 'read'],
    ['pool.dataset.get_instance', 'read'],
    ['system.general.config', 'read'],
    ['service.status', 'read'],
    ['sharing.smb.presets_choices', 'read'],
    ['kerberos.keytab.kerberos_principal_choices', 'read'],
    ['system.info', 'read'],
    ['filesystem.listdir', 'read'],
    ['disk.get_unused', 'read'],
    ['pool.dataset.create', 'write'],
    ['system.general.update', 'write'],
    ['user.set_attribute', 'write'],
    ['pool.scrub.run', 'write'],
    ['service.restart', 'write'],
    ['app.upgrade', 'write'],
    ['pool.detach', 'write'],
    ['pool.dataset.details', 'write'], // ambiguous → write (fail closed)
    ['vm.get_console', 'read'],
    ['core.ping', 'write'],
  ])('%s → %s', (method, expected) => {
    expect(classify(method).classification).toBe(expected);
  });

  it('never infers read for an unknown shape, and says why', () => {
    expect(classify('frobnicate.everything')).toEqual({
      classification: 'write',
      reason: 'default:ambiguous',
      locked: false,
    });
    expect(classify('pool.query').reason).toBe('naming:read(.query)');
  });

  it('locks the destructive list regardless of naming', () => {
    for (const m of LOCKED) expect(classify(m)).toMatchObject({ classification: 'write', locked: true });
    // user.delete would be an ordinary write by name; the list wins.
    expect(classify('user.delete').locked).toBe(true);
    expect(classify('user.update').locked).toBe(false);
    expect(classify('filesystem.setacl#pool-root').locked).toBe(true);
  });

  it('locks every api_key.* method, including ones a future TrueNAS adds', () => {
    for (const m of ['api_key.query', 'api_key.create', 'api_key.delete', 'api_key.some_future_method'])
      expect(classify(m)).toMatchObject({ classification: 'write', locked: true });
    expect(classify('api_keys.query').locked).toBe(false);
  });
});

describe('groupOf', () => {
  it('uses the namespace', () => {
    expect(groupOf('pool.dataset.create')).toBe('pool.dataset');
    expect(groupOf('app.upgrade')).toBe('app');
    expect(groupOf('ping')).toBe('ping');
  });
});

describe('buildCatalog', () => {
  const catalog = buildCatalog(METHODS);
  const op = (key: string) => catalog.operations.find((o) => o.key === key);

  it('produces valid descriptors for every method, minus session plumbing', () => {
    for (const d of catalog.operations) expect(() => OperationDescriptorSchema.parse(d), d.key).not.toThrow();
    expect(op('auth.login_with_api_key')).toBeUndefined();
    expect(catalog.methods.has('pool.query')).toBe(true);
  });

  it('only exposes allowlisted core.* methods, so dispatchers cannot bypass the locked list', () => {
    for (const m of ['core.bulk', 'core.download', 'core.debug', 'core.some_future_method']) {
      expect(buildCatalog({ ...METHODS, [m]: {} }).methods.has(m), m).toBe(false);
    }
    expect(catalog.methods.has('core.get_jobs')).toBe(true);
    expect(catalog.methods.has('core.ping')).toBe(true);
  });

  it('records jobs, schemas, docs, match profiles and typed confirmation', () => {
    expect(catalog.jobs.has('app.upgrade')).toBe(true);
    expect(catalog.jobs.has('pool.query')).toBe(false);
    expect(op('pool.dataset.create')).toMatchObject({
      group: 'pool.dataset',
      classification: 'write',
      matchProfile: 'dataset-name-prefix',
      paramsSchema: { type: 'array', prefixItems: [expect.objectContaining({ title: 'pool_dataset_create' })] },
      docs: { summary: 'Create a dataset or zvol.', guidance: expect.stringContaining('<pool>/<path>') },
    });
    expect(op('app.upgrade')).toMatchObject({ matchProfile: 'app-name-in' });
    expect(op('pool.dataset.delete')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(op('pool.dataset.create')).toMatchObject({ locked: false, typedConfirmation: false });
  });

  it('adds a locked pool-root key next to setacl and chown', () => {
    expect(op('filesystem.setacl')).toMatchObject({ locked: false });
    expect(op('filesystem.setacl#pool-root')).toMatchObject({ locked: true, group: 'filesystem' });
    expect(op('filesystem.chown#pool-root')).toMatchObject({ locked: true });
  });
});

describe('needsPoolRootKey', () => {
  it.each([
    ['/mnt/tank', true],
    ['/mnt/tank/', true],
    ['//mnt//tank//', true],
    ['/mnt', true],
    ['/', true],
    ['/home/x', true],
    ['mnt/tank/media', true],
    ['/mnt/tank/.', true],
    ['/mnt/tank/./', true],
    ['/mnt/tank/media/..', true],
    ['/mnt/tank/../tank', true],
    ['/mnt/tank/media/../../other/x', true],
    ['/mnt/tank/media', false],
    ['/mnt/tank/media/tv/', false],
    [undefined, false],
    [5, false],
  ])('%s → %s', (path, expected) => {
    expect(needsPoolRootKey(path)).toBe(expected);
  });
});
