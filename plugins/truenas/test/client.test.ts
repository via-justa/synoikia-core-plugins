import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl, TrueNasClient, toPluginError } from '../src/client.js';
import { FAKE_API_KEY, startFakeTrueNas } from './fake-truenas.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(apiKey = FAKE_API_KEY, opts: { jobDelayMs?: number } = {}) {
  const fake = await startFakeTrueNas(opts);
  cleanup.push(() => fake.close());
  const client = new TrueNasClient({ baseUrl: fake.url, apiKey }, { timeoutMs: 2000 });
  cleanup.push(() => client.close());
  return { fake, client };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof PluginError ? err.code : String(err);
  }
};

describe('apiUrl', () => {
  it('maps the base URL onto the JSON-RPC endpoint', () => {
    expect(apiUrl('https://nas.lan')).toBe('wss://nas.lan/api/current');
    expect(apiUrl('https://nas.lan/')).toBe('wss://nas.lan/api/current');
    expect(apiUrl('http://10.0.0.5:8080')).toBe('ws://10.0.0.5:8080/api/current');
    expect(apiUrl('https://proxy.lan/truenas/')).toBe('wss://proxy.lan/truenas/api/current');
    expect(() => apiUrl('ftp://nas.lan')).toThrow(/scheme/);
  });
});

describe('TrueNasClient', () => {
  it('signs in with the API key and calls methods', async () => {
    const { fake, client } = await setup();
    expect(await client.call('system.version')).toBe('TrueNAS-25.04.2');
    expect(await client.call('pool.query', [[]])).toEqual([{ id: 1, name: 'tank', status: 'ONLINE' }]);
    expect(fake.calls.map((c) => c.method)).toEqual(['auth.login_with_api_key', 'system.version', 'pool.query']);
  });

  it('refuses a wrong API key without echoing it', async () => {
    const { client } = await setup('wrong-key-9999');
    const err = await client.call('system.version').catch((e: unknown) => e as PluginError);
    expect(err).toMatchObject({ code: ErrorCodes.UpstreamDenied });
    expect((err as Error).message).not.toContain('wrong-key-9999');
  });

  it('maps permission, validation and other errors', async () => {
    const { fake, client } = await setup();
    fake.denied.add('user.query');
    expect(await codeOf(client.call('user.query'))).toBe(ErrorCodes.UpstreamDenied);
    expect(await codeOf(client.call('pool.dataset.create', [{ name: 'nopool' }]))).toBe(ErrorCodes.InvalidParams);
    expect(await codeOf(client.call('pool.dataset.delete', ['tank/none']))).toBe(ErrorCodes.UpstreamError);
    expect(await codeOf(client.call('no.such.method'))).toBe(ErrorCodes.UnknownOperation);
  });

  it('waits for jobs and reports their failure', async () => {
    const { client } = await setup();
    expect(await client.callJob('app.upgrade', ['plex', {}])).toEqual({ name: 'plex', upgraded: true });
    const err = await client.callJob('pool.scrub.run', ['nope']).catch((e: unknown) => e as PluginError);
    expect(err).toMatchObject({ code: ErrorCodes.UpstreamError, message: expect.stringContaining('not found') });
  });

  it('gives up on a job at the deadline, saying it may still complete', async () => {
    const { client } = await setup(FAKE_API_KEY, { jobDelayMs: 1000 });
    await expect(client.callJob('app.upgrade', ['plex', {}], 300)).rejects.toThrow(/may still complete/);
  });

  it('reconnects on the next call after the connection drops', async () => {
    const { fake, client } = await setup();
    await client.call('core.ping');
    fake.drop();
    await new Promise((r) => setTimeout(r, 50));
    expect(await client.call('core.ping')).toBe('pong');
    expect(fake.calls.filter((c) => c.method === 'auth.login_with_api_key')).toHaveLength(2);
  });

  it('fails cleanly when TrueNAS is unreachable', async () => {
    const client = new TrueNasClient({ baseUrl: 'http://127.0.0.1:1', apiKey: FAKE_API_KEY }, { timeoutMs: 1000 });
    expect(await codeOf(client.call('core.ping'))).toBe(ErrorCodes.UpstreamError);
  });
});

describe('toPluginError', () => {
  it('treats "not authorized" text as a denial even without an errname', () => {
    expect(toPluginError('x', { message: 'Not authorized' }).code).toBe(ErrorCodes.UpstreamDenied);
    expect(toPluginError('x', { message: 'boom' }).code).toBe(ErrorCodes.UpstreamError);
  });
});
