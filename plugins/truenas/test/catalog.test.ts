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
    expect(classify('pool.dataset.export_key')).toMatchObject({ classification: 'write', locked: true });
    expect(classify('user.update').locked).toBe(false);
    expect(classify('filesystem.setacl#pool-root').locked).toBe(true);
  });

  it('reads the declared roles before the name', () => {
    // Named like a write, but a read-only role may call it: a read.
    expect(classify('pool.dataset.details', ['DATASET_READ', 'DATASET_WRITE'])).toMatchObject({
      classification: 'read',
      reason: 'roles:read(DATASET_READ)',
    });
    expect(classify('disk.temperatures', ['READONLY_ADMIN'])).toMatchObject({ classification: 'read' });
    // Named like a read, but only a write role may call it: a write.
    expect(classify('vm.get_console', ['VM_WRITE'])).toMatchObject({
      classification: 'write',
      reason: 'roles:write(VM_WRITE)',
    });
    expect(classify('system.general.update', ['FULL_ADMIN'])).toMatchObject({
      classification: 'write',
      reason: 'roles:write(FULL_ADMIN)',
    });
    // No roles declared: naming conventions, ambiguous still a write.
    expect(classify('pool.query', [])).toMatchObject({ classification: 'read', reason: 'naming:read(.query)' });
    expect(classify('pool.dataset.details', null).classification).toBe('write');
    // The locked list beats roles.
    expect(classify('pool.dataset.delete', ['DATASET_READ'])).toMatchObject({ locked: true, classification: 'write' });
  });

  it('classifies the role lists TrueNAS 25.04 actually returns', () => {
    // `core.get_methods` lists every role granting a method, expanded through includes, so a read method
    // also lists its write role's read role, READONLY_ADMIN and SHARING_ADMIN.
    expect(
      classify('pool.dataset.query', ['DATASET_READ', 'DATASET_WRITE', 'READONLY_ADMIN', 'SHARING_ADMIN']),
    ).toMatchObject({ classification: 'read', reason: 'roles:read(DATASET_READ)' });
    expect(
      classify('pool.dataset.encryption_summary', ['DATASET_READ', 'DATASET_WRITE', 'READONLY_ADMIN']),
    ).toMatchObject({ classification: 'read' });
    expect(classify('pool.dataset.unlock', ['DATASET_WRITE', 'SHARING_ADMIN'])).toMatchObject({
      classification: 'write',
      reason: 'roles:write(DATASET_WRITE)',
    });
    expect(classify('app.query', ['APPS_READ', 'APPS_WRITE', 'READONLY_ADMIN'])).toMatchObject({
      classification: 'read',
    });
    // A method without explicit roles gets an empty list (FULL_ADMIN only): the name decides.
    expect(classify('system.info', [])).toMatchObject({ classification: 'read', reason: 'naming:read(.info)' });
  });

  it('never lets roles turn a write-named method into a read', () => {
    for (const m of [
      'pool.dataset.create',
      'x.run_foo',
      'x.set_foo',
      'vm.update',
      'service.restart',
      'pool.dataset.unlock',
      'zfs.snapshot.rollback',
      'pool.dataset.promote',
      'auth.generate_onetime_password',
      'user.renew_2fa_secret',
      'app.redeploy',
      'auth.terminate_session',
      'mail.send',
      'interface.commit',
    ])
      expect(classify(m, ['DATASET_READ', 'READONLY_ADMIN']).classification).toBe('write');
    // An unclear name is settled by a read role; a read-named method stays a read.
    expect(classify('pool.dataset.details', ['DATASET_READ']).classification).toBe('read');
    expect(classify('pool.query', ['POOL_READ'])).toMatchObject({
      classification: 'read',
      reason: 'roles:read(POOL_READ)',
    });
  });

  it('ignores a roles value that is not a list', () => {
    expect(() => classify('pool.query', 'POOL_READ')).not.toThrow();
    expect(classify('pool.query', 'POOL_READ')).toMatchObject({
      classification: 'read',
      reason: 'naming:read(.query)',
    });
    expect(classify('pool.dataset.details', { POOL_READ: true }).classification).toBe('write');
    expect(classify('pool.query', [42, null, 'POOL_READ'])).toMatchObject({ reason: 'roles:read(POOL_READ)' });
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

  it('classifies synced methods by their declared roles', () => {
    const cat = buildCatalog({
      'pool.dataset.details': { description: 'Dataset details.', roles: ['DATASET_READ'] },
      'pool.dataset.create': { roles: ['DATASET_WRITE'] },
    });
    expect(cat.operations.find((o) => o.key === 'pool.dataset.details')).toMatchObject({
      classification: 'read',
      classificationReason: 'roles:read(DATASET_READ)',
      docs: { summary: 'Dataset details.' },
    });
    expect(cat.operations.find((o) => o.key === 'pool.dataset.create')).toMatchObject({ classification: 'write' });
  });

  it('declares secrets in params that have no key name for core to redact', () => {
    const cat = buildCatalog({
      'user.setup_local_administrator': {},
      'pool.dataset.create': {},
      'pool.dataset.unlock': {},
      'pool.dataset.encryption_summary': {},
      'kerberos.keytab.create': {},
      'cloudsync.credentials.update': {},
      'pool.query': {},
    });
    const find = (k: string) => cat.operations.find((o) => o.key === k);
    expect(find('user.setup_local_administrator')?.sensitiveParams).toEqual(['/1']);
    expect(find('pool.dataset.create')?.sensitiveParams).toEqual(['/0/encryption_options/key']);
    expect(find('pool.dataset.unlock')?.sensitiveParams).toHaveLength(32);
    expect(find('pool.dataset.unlock')?.sensitiveParams).toContain('/1/datasets/31/key');
    expect(find('pool.dataset.encryption_summary')?.sensitiveParams).toContain('/1/datasets/0/key');
    expect(find('kerberos.keytab.create')?.sensitiveParams).toEqual(['/0/file']);
    expect(find('cloudsync.credentials.update')?.sensitiveParams).toEqual(['/1/provider/key']);
    expect(find('pool.query')?.sensitiveParams).toBeUndefined();
    for (const o of cat.operations) expect(() => OperationDescriptorSchema.parse(o)).not.toThrow();
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
