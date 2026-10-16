import { createHmac } from 'node:crypto';
import { isPlainObject } from '@synoikia/plugin-sdk';

/** Tracker, web seed, feed and search URLs carry passkeys and API keys in their path or query: results show each
 * URL as its origin plus a keyed token, and writes take the masked form back (design: URLs in results). */

const MARK = /<masked:([0-9a-f]{12})>/;
const IN_TEXT = /\b(?:https?|udp|wss?):\/\/[^\s"'<>]+|\bmagnet:\?[^\s"'<>]+/gi;
/** Masked URLs remembered for writes that take them back; the oldest are forgotten first. */
const MAX_REMEMBERED = 20_000;

export class UrlMasker {
  private readonly seen = new Map<string, string>();

  constructor(private readonly key: Uint8Array) {}

  private token(url: string): string {
    const token = createHmac('sha256', this.key).update(url).digest('hex').slice(0, 12);
    if (!this.seen.has(token)) {
      if (this.seen.size >= MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(token, url);
    }
    return `<masked:${token}>`;
  }

  /** One URL as shown: a magnet keeps its hash and name, any other URL its scheme, host and port. */
  url(url: string): string {
    if (/^magnet:\?/i.test(url)) {
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const kept = [...params].filter(([k]) => k === 'xt' || k === 'dn');
      const visible = kept.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%3A/gi, ':')}`).join('&');
      return kept.length === [...params].length ? url : `magnet:?${visible}${visible ? '&' : ''}${this.token(url)}`;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return this.token(url);
    }
    const bare = !parsed.username && !parsed.password && ['', '/'].includes(parsed.pathname) && !parsed.search;
    if (bare && !parsed.hash) return url;
    return `${parsed.protocol}//${parsed.host}/${this.token(url)}`;
  }

  /** Text with every URL in it masked. */
  text(text: string): string {
    return text.replace(IN_TEXT, (m) => this.url(m));
  }

  /** A result with every URL in its strings and keys masked; keys that mask alike are merged. */
  deep(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.deep(v));
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = this.text(k);
      const masked = this.deep(v);
      const prev = Object.hasOwn(out, key) ? out[key] : undefined;
      const merged = Array.isArray(prev) && Array.isArray(masked) ? [...prev, ...masked] : (prev ?? masked);
      Object.defineProperty(out, key, { value: merged, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  /** Whether a value is (or holds) a masked URL. */
  static isMasked(value: string): boolean {
    return MARK.test(value);
  }

  /** The URL a masked value stands for, or the value itself when it holds no mask; undefined for a mask this
   * plugin did not hand out (or no longer remembers). */
  unmask(value: string): string | undefined {
    const m = MARK.exec(value);
    if (!m) return value;
    const real = this.seen.get(m[1]!);
    return real !== undefined && this.url(real) === value ? real : undefined;
  }
}
