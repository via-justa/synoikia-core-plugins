import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { HaClient, restBase, toPluginError, wsUrl } from '../src/client.js';
import { FAKE_TOKEN, startFakeHa } from './fake-ha.js';
import type { FakeHa } from './fake-ha.js';

let fake: FakeHa;
const clients: HaClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await fake?.close();
});

const client = (token = FAKE_TOKEN, opts: ConstructorParameters<typeof HaClient>[1] = {}) => {
  const c = new HaClient({ baseUrl: fake.url, token }, opts);
  clients.push(c);
  return c;
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  return check();
};

describe('URLs', () => {
  it('maps the base URL to the WebSocket and REST endpoints, keeping a base path', () => {
    expect(wsUrl('https://ha.lan:8123/')).toBe('wss://ha.lan:8123/api/websocket');
    expect(wsUrl('http://proxy.lan/ha')).toBe('ws://proxy.lan/ha/api/websocket');
    expect(restBase('http://proxy.lan/ha/')).toBe('http://proxy.lan/ha/api');
    expect(() => wsUrl('ftp://ha.lan')).toThrow(/scheme/);
  });
});

describe('error mapping (HA §4)', () => {
  it.each([
    [{ code: 'unauthorized', message: 'Unauthorized' }, ErrorCodes.UpstreamDenied],
    [{ status: 401 }, ErrorCodes.UpstreamDenied],
    [{ code: 'invalid_format', message: 'extra keys' }, ErrorCodes.InvalidParams],
    [{ code: 'service_validation_error', message: 'out of range' }, ErrorCodes.InvalidParams],
    [{ status: 400 }, ErrorCodes.InvalidParams],
    [{ code: 'not_found', message: 'Service not found' }, ErrorCodes.UpstreamError],
    [{ status: 500 }, ErrorCodes.UpstreamError],
  ])('%j → %s', (err, code) => {
    expect(toPluginError('x', err).code).toBe(code);
  });
});

describe('HaClient', () => {
  it('signs in with the token and runs commands', async () => {
    fake = await startFakeHa();
    const c = client();
    expect(await c.command('get_config')).toMatchObject({ version: '2026.9.1' });
    expect(c.version).toBe('2026.9.1');
    expect(await c.command('call_service', { domain: 'light', service: 'turn_on', service_data: {} })).toMatchObject({
      context: { id: 'c1' },
    });
  });

  it('rejects a wrong token without echoing it', async () => {
    fake = await startFakeHa();
    const err = (await client('wrong-token-xyz')
      .command('get_config')
      .catch((e: unknown) => e)) as PluginError;
    expect(err.code).toBe(ErrorCodes.UpstreamDenied);
    expect(err.message).toMatch(/rejected the access token/);
    expect(err.message).not.toContain('wrong-token-xyz');
  });

  it('maps command errors', async () => {
    fake = await startFakeHa();
    fake.denied.add('get_states');
    const c = client();
    await expect(c.command('get_states')).rejects.toMatchObject({ code: ErrorCodes.UpstreamDenied });
    await expect(c.command('call_service', { domain: 'nope', service: 'x' })).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringMatching(/not found/),
    });
    await expect(c.command('no/such/command')).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
  });

  it('reconnects on the next call after a drop, and re-subscribes', async () => {
    fake = await startFakeHa();
    const seen: string[] = [];
    const c = client(FAKE_TOKEN, { events: ['area_registry_updated'], onEvent: (t) => seen.push(t) });
    await c.command('get_config');
    fake.drop();
    await until(() => false); // let the close land
    expect(await c.command('get_config')).toMatchObject({ version: '2026.9.1' });
    expect(await until(() => fake.calls.filter((x) => x.type === 'get_config').length === 2)).toBe(true);
    await until(() => false);
    fake.emit('area_registry_updated', { action: 'update' });
    expect(await until(() => seen.length === 1)).toBe(true);
  });

  it('calls the REST config endpoints with the token', async () => {
    fake = await startFakeHa();
    const c = client();
    expect(await c.rest('GET', '/config/automation/config/morning')).toMatchObject({ alias: 'Morning lights' });
    await expect(c.rest('GET', '/config/automation/config/nope')).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      data: { status: 404 },
    });
    await expect(client('bad').rest('GET', '/config/automation/config/morning')).rejects.toMatchObject({
      code: ErrorCodes.UpstreamDenied,
    });
  });

  it('reports an unreachable Home Assistant cleanly', async () => {
    fake = await startFakeHa();
    const url = fake.url;
    await fake.close();
    const c = new HaClient({ baseUrl: url, token: FAKE_TOKEN }, { timeoutMs: 2000 });
    clients.push(c);
    await expect(c.command('get_config')).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringMatching(/unreachable/),
    });
    await expect(c.rest('GET', '/config/automation/config/x')).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
    });
  });
});
