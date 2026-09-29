import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

/**
 * A small fake TrueNAS for tests: JSON-RPC 2.0 over WebSocket at `/api/current`, API-key login, a
 * realistic slice of `core.get_methods`, in-memory datasets, jobs, and one method that is denied.
 */

export const FAKE_API_KEY = '1-fake-truenas-api-key-abcdef';

interface MethodInfo {
  description?: string;
  accepts?: unknown[];
  job?: boolean;
  roles?: string[];
}

type Handler = (params: unknown[]) => unknown;

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const methodError = (errname: string, reason: string, extra?: unknown) =>
  new RpcFailure(-32001, 'Method call error', { error: 1, errname, reason, ...(extra ? { extra } : {}) });

const obj = (title: string, properties: Record<string, unknown> = {}) => ({ type: 'object', title, properties });

/** The catalog `core.get_methods` returns (a slice of a real 25.04 system). */
export const METHODS: Record<string, MethodInfo> = {
  'pool.query': { description: 'Query pools.', accepts: [{ type: 'array', title: 'filters' }] },
  'pool.get_instance': { description: 'Get one pool.', accepts: [{ type: 'integer', title: 'id' }] },
  'pool.export': { description: 'Export a pool.', accepts: [{ type: 'integer', title: 'id' }], job: true },
  'pool.dataset.query': { description: 'Query datasets.', accepts: [{ type: 'array', title: 'filters' }] },
  'pool.dataset.create': {
    description: 'Create a dataset or zvol.',
    accepts: [obj('pool_dataset_create', { name: { type: 'string' }, quota: { type: 'integer' } })],
  },
  'pool.dataset.delete': {
    description: 'Delete a dataset.',
    accepts: [{ type: 'string', title: 'id' }, obj('options', { recursive: { type: 'boolean' } })],
  },
  'pool.dataset.change_key': {
    description: 'Change a dataset key.',
    accepts: [{ type: 'string', title: 'id' }],
    job: true,
  },
  'pool.dataset.details': { description: 'Dataset details.' },
  'pool.scrub.run': { description: 'Run a scrub.', accepts: [{ type: 'string', title: 'name' }], job: true },
  'app.query': { description: 'Query apps.', accepts: [{ type: 'array', title: 'filters' }] },
  'app.upgrade': {
    description: 'Upgrade an app.',
    accepts: [{ type: 'string', title: 'app_name' }, obj('options')],
    job: true,
  },
  'app.available_space': { description: 'Space for apps.' },
  'disk.query': { description: 'Query disks.' },
  'disk.wipe': {
    description: 'Wipe a disk.',
    accepts: [
      { type: 'string', title: 'dev' },
      { type: 'string', title: 'mode' },
    ],
    job: true,
  },
  'system.info': { description: 'System information.' },
  'system.version': { description: 'TrueNAS version.' },
  'system.reboot': { description: 'Reboot.', job: true },
  'system.shutdown': { description: 'Shut down.', job: true },
  'system.general.config': { description: 'General settings.' },
  'system.general.update': { description: 'Update general settings.', accepts: [obj('system_general_update')] },
  'config.reset': { description: 'Reset configuration.', job: true },
  'user.query': { description: 'Query users.' },
  'user.get_instance': { description: 'Get one user.', accepts: [{ type: 'integer', title: 'id' }] },
  'user.delete': { description: 'Delete a user.', accepts: [{ type: 'integer', title: 'id' }] },
  'user.set_password': {
    description: 'Set a password.',
    accepts: [obj('set_password', { username: { type: 'string' } })],
  },
  'filesystem.setacl': {
    description: 'Set an ACL.',
    accepts: [obj('filesystem_acl', { path: { type: 'string' } })],
    job: true,
  },
  'filesystem.chown': {
    description: 'Change owner.',
    accepts: [obj('filesystem_ownership', { path: { type: 'string' } })],
    job: true,
  },
  'filesystem.listdir': { description: 'List a directory.' },
  'sharing.smb.query': { description: 'Query SMB shares.' },
  'sharing.smb.create': { description: 'Create an SMB share.', accepts: [obj('smb_share_create')] },
  'core.get_jobs': { description: 'Query jobs.' },
  'core.ping': { description: 'Ping.' },
  'core.bulk': { description: 'Call a method once per params set.', job: true },
  'core.download': { description: 'Run a method and serve its output for download.' },
  'core.debug': { description: 'Attach a remote debugger.' },
  'service.restart': { description: 'Restart a service.', accepts: [{ type: 'string', title: 'service' }], job: true },
  'kerberos.keytab.kerberos_principal_choices': { description: 'Principals.' },
  'kerberos.keytab.query': { description: 'Query keytabs.' },
  'ups.config': { description: 'UPS settings.' },
  'snmp.config': { description: 'SNMP settings.' },
  'ssh.config': { description: 'SSH settings.' },
  'vm.get_console': { description: 'An oddly named method.' },
};

export interface FakeTrueNas {
  url: string;
  datasets: Map<string, { id: string; name: string; quota?: number }>;
  calls: { method: string; params: unknown[] }[];
  /** Methods that answer EACCES, as for a key without the needed role. */
  denied: Set<string>;
  version: string;
  /** Close every open connection (the client must reconnect). */
  drop(): void;
  close(): Promise<void>;
}

export async function startFakeTrueNas(opts: { jobDelayMs?: number } = {}): Promise<FakeTrueNas> {
  const datasets = new Map<string, { id: string; name: string; quota?: number }>([
    ['tank', { id: 'tank', name: 'tank' }],
    ['tank/media', { id: 'tank/media', name: 'tank/media' }],
  ]);
  const jobs = new Map<
    number,
    { id: number; method: string; state: string; result?: unknown; error?: string | null }
  >();
  let nextJob = 1;
  const calls: { method: string; params: unknown[] }[] = [];
  const denied = new Set<string>();
  const state = { version: 'TrueNAS-25.04.2' };

  const job = (method: string, run: () => unknown): number => {
    const id = nextJob++;
    const entry: { id: number; method: string; state: string; result?: unknown; error?: string | null } = {
      id,
      method,
      state: 'RUNNING',
    };
    jobs.set(id, entry);
    setTimeout(() => {
      try {
        entry.result = run();
        entry.state = 'SUCCESS';
      } catch (err) {
        entry.state = 'FAILED';
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }, opts.jobDelayMs ?? 30);
    return id;
  };

  const handlers: Record<string, Handler> = {
    'core.get_methods': () => METHODS,
    'core.ping': () => 'pong',
    'system.version': () => state.version,
    'system.info': () => ({ hostname: 'nas01', version: state.version }),
    'pool.query': () => [{ id: 1, name: 'tank', status: 'ONLINE' }],
    'pool.get_instance': ([id]) => {
      if (id !== 1) throw methodError('ENOENT', `Pool ${String(id)} does not exist`);
      return { id: 1, name: 'tank' };
    },
    'pool.export': () => job('pool.export', () => null),
    'pool.dataset.query': () => [...datasets.values()],
    'pool.dataset.create': ([data]) => {
      const { name, quota } = (data ?? {}) as { name?: unknown; quota?: number };
      if (typeof name !== 'string' || !name.includes('/'))
        throw methodError('EINVAL', 'Invalid dataset name', [['pool_dataset_create.name', 'Invalid name', 22]]);
      if (datasets.has(name)) throw methodError('EEXIST', `${name} already exists`);
      const row = { id: name, name, ...(quota !== undefined ? { quota } : {}) };
      datasets.set(name, row);
      return row;
    },
    'pool.dataset.delete': ([id]) => {
      if (!datasets.delete(String(id))) throw methodError('ENOENT', `${String(id)} does not exist`);
      return true;
    },
    'app.query': () => [
      { name: 'plex', state: 'RUNNING' },
      { name: 'sonarr', state: 'RUNNING' },
    ],
    'app.upgrade': ([name]) => job('app.upgrade', () => ({ name, upgraded: true })),
    'pool.scrub.run': ([name]) =>
      job('pool.scrub.run', () => {
        if (name !== 'tank') throw new Error(`[ENOENT] Pool ${String(name)} not found`);
        return null;
      }),
    'disk.query': () => [{ name: 'sda', serial: 'S1' }],
    'user.query': () => [
      { id: 1, username: 'root' },
      { id: 70, username: 'alice' },
    ],
    'user.get_instance': ([id]) => ({ id, username: id === 70 ? 'alice' : 'root' }),
    'sharing.smb.query': () => [
      { id: 1, name: 'media', path: '/mnt/tank/media', auxsmbconf: '', password: 'share-secret-123' },
    ],
    // Secret-bearing reads (review of PR #8): each field name must come back redacted.
    'ups.config': () => ({ id: 1, monuser: 'upsmon', monpwd: 'ups-secret-456' }),
    'snmp.config': () => ({ id: 1, community: 'snmp-secret-789', v3: false }),
    'ssh.config': () => ({
      id: 1,
      tcpport: 22,
      host_ed25519_key: 'ssh-secret-key',
      host_ed25519_key_pub: 'ssh-ed25519 AAAA',
    }),
    'kerberos.keytab.query': () => [{ id: 1, name: 'AD_MACHINE_ACCOUNT', file: 'keytab-secret-b64' }],
    'core.get_jobs': ([filters]) => {
      const id = ((filters as unknown[][])[0] ?? [])[2];
      const j = jobs.get(Number(id));
      return j ? [j] : [];
    },
  };

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/api/current' });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    let authenticated = false;
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as { id: number; method: string; params?: unknown[] };
      const params = req.params ?? [];
      const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
      calls.push({ method: req.method, params: req.method === 'auth.login_with_api_key' ? ['<redacted>'] : params });
      try {
        if (req.method === 'auth.login_with_api_key') {
          authenticated = params[0] === FAKE_API_KEY;
          return reply({ result: authenticated });
        }
        if (!authenticated) throw methodError('ENOTAUTHENTICATED', 'Not authenticated');
        if (denied.has(req.method)) throw methodError('EACCES', 'Not authorized');
        const handler = handlers[req.method];
        if (handler) return reply({ result: handler(params) });
        if (METHODS[req.method]) return reply({ result: null });
        throw new RpcFailure(-32601, 'Method does not exist');
      } catch (err) {
        if (err instanceof RpcFailure)
          return reply({ error: { code: err.code, message: err.message, data: err.data } });
        return reply({ error: { code: -32603, message: String(err) } });
      }
    });
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    datasets,
    calls,
    denied,
    get version() {
      return state.version;
    },
    set version(v: string) {
      state.version = v;
    },
    drop: () => {
      for (const s of sockets) s.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close(() => resolve());
      }),
  };
}
