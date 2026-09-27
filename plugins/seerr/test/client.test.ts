import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { apiBase, queryString, SeerrClient } from '../src/client.js';
import { fetchSpec, tagFor } from '../src/spec.js';
import { FAKE_API_KEY, FAKE_EMAIL, FAKE_PASSWORD, startFakeSeerr } from './fake-seerr.js';
import type { FakeSeerr } from './fake-seerr.js';

let fake: FakeSeerr;
afterEach(async () => {
  await fake?.close();
});

const local = () => new SeerrClient(fake.url, { kind: 'local', email: FAKE_EMAIL, password: FAKE_PASSWORD });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof PluginError ? err.code : String(err);
  }
};

describe('apiBase / queryString', () => {
  it('appends /api/v1 and keeps a base path', () => {
    expect(apiBase('https://seerr.lan/')).toBe('https://seerr.lan/api/v1');
    expect(apiBase('https://proxy.lan/seerr/')).toBe('https://proxy.lan/seerr/api/v1');
    expect(() => apiBase('ftp://seerr.lan')).toThrow(/scheme/);
    expect(() => apiBase('not a url')).toThrow(/valid URL/);
  });

  it('repeats array keys, JSON-encodes objects, drops null', () => {
    expect(queryString({ take: 10, filter: ['a', 'b'], x: null, o: { a: 1 } })).toBe(
      '?take=10&filter=a&filter=b&o=%7B%22a%22%3A1%7D',
    );
    expect(queryString({})).toBe('');
  });
});

describe('SeerrClient', () => {
  it('signs in as the local user once and reuses the session cookie', async () => {
    fake = await startFakeSeerr();
    const client = local();
    expect(await client.request('GET', '/auth/me')).toMatchObject({ id: 2 });
    expect(await client.request('GET', '/request')).toMatchObject({ results: expect.any(Array) });
    expect(fake.calls.filter((c) => c.path === '/auth/local')).toHaveLength(1);
    expect(fake.calls.at(-1)?.cookie).toMatch(/^s%3Asession-/);
  });

  it('signs in again once when the session has expired, then retries the call', async () => {
    fake = await startFakeSeerr();
    const client = local();
    await client.request('GET', '/auth/me');
    fake.expireSessions();
    expect(await client.request('POST', '/request', { body: { mediaType: 'movie', mediaId: 550 } })).toMatchObject({
      is4k: false,
    });
    expect(fake.calls.filter((c) => c.path === '/auth/local')).toHaveLength(2);
    // The rejected attempt never reached the handler, so exactly one request was created.
    expect([...fake.requests.values()].filter((r) => r.media.tmdbId === 550)).toHaveLength(1);
  });

  it('reports a permission denial as UPSTREAM_DENIED after one re-sign-in', async () => {
    fake = await startFakeSeerr();
    fake.denied.add('/settings/main');
    const client = local();
    const err = await client.request('GET', '/settings/main').catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: ErrorCodes.UpstreamDenied,
      message: expect.stringMatching(/insufficient permission/),
    });
    expect(fake.calls.filter((c) => c.path === '/auth/local')).toHaveLength(2);
  });

  it('rejects a wrong password without echoing it', async () => {
    fake = await startFakeSeerr();
    const client = new SeerrClient(fake.url, { kind: 'local', email: FAKE_EMAIL, password: 'wrong-password-xyz' });
    const err = (await client.request('GET', '/auth/me').catch((e: unknown) => e)) as PluginError;
    expect(err.code).toBe(ErrorCodes.UpstreamDenied);
    expect(err.message).toMatch(/rejected the local user/);
    expect(err.message).not.toContain('wrong-password-xyz');
  });

  it('sends the API key and X-API-User, with no sign-in', async () => {
    fake = await startFakeSeerr();
    const client = new SeerrClient(fake.url, { kind: 'apiKey', apiKey: FAKE_API_KEY, actAsUserId: 14 });
    expect(await client.request('GET', '/auth/me')).toMatchObject({ id: 14 });
    expect(fake.calls.at(-1)).toMatchObject({ apiKey: '<set>', apiUser: '14' });
    expect(fake.calls.some((c) => c.path === '/auth/local')).toBe(false);
    const bad = new SeerrClient(fake.url, { kind: 'apiKey', apiKey: 'nope' });
    expect(await codeOf(bad.request('GET', '/auth/me'))).toBe(ErrorCodes.UpstreamDenied);
  });

  it('maps validation errors, missing resources and unreachable hosts', async () => {
    fake = await startFakeSeerr();
    const client = local();
    const invalid = await client.request('POST', '/request', { body: { mediaType: 'book' } }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ code: ErrorCodes.InvalidParams, message: 'POST /request: Invalid media type' });
    expect(await codeOf(client.request('GET', '/request/999'))).toBe(ErrorCodes.UpstreamError);
    const url = fake.url;
    await fake.close();
    const gone = await new SeerrClient(url, { kind: 'apiKey', apiKey: 'k' })
      .request('GET', '/status')
      .catch((e: unknown) => e);
    expect(gone).toMatchObject({ code: ErrorCodes.UpstreamError, message: expect.stringMatching(/unreachable/) });
  });

  it('returns null for an empty body', async () => {
    fake = await startFakeSeerr();
    expect(await local().request('DELETE', '/request/7')).toBeNull();
  });
});

describe('fetchSpec (SR §2.2, §7 phase 3)', () => {
  it('maps a release version to its tag', () => {
    expect(tagFor('3.4.1')).toBe('v3.4.1');
    expect(tagFor('v2.7.0')).toBe('v2.7.0');
    expect(tagFor('develop-abc123')).toBeUndefined();
  });

  it('fetches the spec for the matching release tag', async () => {
    fake = await startFakeSeerr();
    expect(await fetchSpec('3.4.1', fake.specUrl)).toMatchObject({
      ref: 'v3.4.1',
      text: expect.stringContaining('openapi'),
    });
  });

  it('falls back to develop when the tag has no spec, or the version is not a release', async () => {
    fake = await startFakeSeerr();
    expect((await fetchSpec('9.9.9', fake.specUrl)).ref).toBe('develop');
    expect(fake.specFetches).toEqual(['v9.9.9', 'develop']);
    expect((await fetchSpec('develop-abc123', `${fake.specUrl}/`)).ref).toBe('develop');
  });

  it('fails when neither exists, or the source is unreachable', async () => {
    fake = await startFakeSeerr();
    fake.specRefs.clear();
    await expect(fetchSpec('3.4.1', fake.specUrl)).rejects.toThrow(/No Seerr API spec found/);
    const url = fake.specUrl;
    await fake.close();
    await expect(fetchSpec('3.4.1', url)).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
  });
});
