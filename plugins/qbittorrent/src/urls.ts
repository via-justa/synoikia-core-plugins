/** URLs qBittorrent fetches are parsed by Qt's QUrl, the origins approvers see by Node's WHATWG URL. The two differ
 * (`https://a.example\@b.example/` is host a.example to Node and b.example to QUrl), so a URL is accepted only when
 * nothing in it can be read two ways: no backslash, whitespace or control character, no userinfo, and Node's host
 * equal to the authority as written. */

// eslint-disable-next-line no-control-regex
const AMBIGUOUS = /[\\\s\x00-\x1f\x7f]/;
const AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };

/** A magnet link's params as libtorrent's `parse_magnet_uri` keys them: names compared case-insensitively, a
 * `.<digits>` (or bare `.`) suffix after the first `.` stripped (`TR.1`, `tr.` are `tr`; `x.pe` stays), values
 * percent-decoded with `+` as a space. A value that does not decode (`%FF`, which libtorrent decodes bytewise) is
 * kept raw and marked, and the checks refuse it. */
export function magnetParams(magnet: string): { key: string; value: string; decoded: boolean }[] {
  return magnet
    .slice(magnet.indexOf('?') + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      const raw = eq < 0 ? '' : pair.slice(eq + 1);
      const dot = name.indexOf('.');
      const key = dot >= 0 && /^\d*$/.test(name.slice(dot + 1)) ? name.slice(0, dot) : name;
      try {
        return { key, value: decodeURIComponent(raw.replace(/\+/g, ' ')), decoded: true };
      } catch {
        return { key, value: raw, decoded: false };
      }
    });
}

/** Keys whose values qBittorrent's libtorrent contacts as URLs, and the schemes each may use. */
const MAGNET_URL_KEYS: Record<string, RegExp> = {
  tr: /^(https?|udp):\/\//i,
  ws: /^https?:\/\//i,
  xs: /^https?:\/\//i,
  as: /^https?:\/\//i,
};
/** Keys whose values are `host:port` endpoints libtorrent connects to: a peer (`x.pe`) and a DHT node (`dht`). */
export const MAGNET_ENDPOINT_KEYS: Record<string, string> = { 'x.pe': 'peer', dht: 'DHT node' };
const ENDPOINT = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/i;

/** The tracker, web seed and source URLs in a magnet link. */
export function magnetUrls(magnet: string): string[] {
  return magnetParams(magnet)
    .filter(({ key }) => Object.hasOwn(MAGNET_URL_KEYS, key))
    .map(({ value }) => value);
}

/** The peer and DHT node endpoints in a magnet link, as `peer 10.0.0.1:6881`. */
export function magnetEndpoints(magnet: string): string[] {
  return magnetParams(magnet)
    .filter(({ key }) => Object.hasOwn(MAGNET_ENDPOINT_KEYS, key))
    .map(({ key, value }) => `${MAGNET_ENDPOINT_KEYS[key]!} ${value}`);
}

function magnetProblem(raw: string): string | undefined {
  for (const { key, value, decoded } of magnetParams(raw)) {
    const checked = Object.hasOwn(MAGNET_URL_KEYS, key) || Object.hasOwn(MAGNET_ENDPOINT_KEYS, key);
    if (checked && !decoded) return `has a ${key} value that is not valid percent-encoded UTF-8`;
    const scheme = MAGNET_URL_KEYS[key];
    if (scheme) {
      if (!scheme.test(value))
        return `names a tracker or source (${key}) that is not an ${key === 'tr' ? 'http(s) or udp' : 'http(s)'} URL`;
      const problem = urlProblem(value);
      if (problem) return `names a tracker or source (${key}) that ${problem}`;
    } else if (Object.hasOwn(MAGNET_ENDPOINT_KEYS, key) && !ENDPOINT.test(value)) {
      return `names a ${MAGNET_ENDPOINT_KEYS[key]!} that is not a host:port`;
    }
  }
  return undefined;
}

/** Why a URL would not be read the same by Node and qBittorrent, or undefined when it would. Never quotes the URL. */
export function urlProblem(raw: string): string | undefined {
  if (AMBIGUOUS.test(raw)) return 'contains a backslash, whitespace or a control character';
  if (/^magnet:\?/i.test(raw)) return magnetProblem(raw);
  const m = AUTHORITY.exec(raw);
  if (!m) return 'is not an absolute URL';
  const authority = m[2]!;
  if (!authority || authority.includes('@')) return 'has user credentials or no host';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  let written = authority.toLowerCase();
  const port = DEFAULT_PORTS[m[1]!.toLowerCase()];
  if (port && written.endsWith(`:${port}`)) written = written.slice(0, -port.length - 1);
  if (parsed.host.toLowerCase() !== written) return 'has a host that parses differently';
  return undefined;
}
