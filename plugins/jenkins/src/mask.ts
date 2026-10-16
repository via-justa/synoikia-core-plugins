import { isPlainObject, REDACTED } from '@synoikia/plugin-sdk';

/** Password-like parameter types and values (`PasswordParameterDefinition`, `PasswordParameterValue`, and
 * plugins' secret or credentials parameters), by `_class` or `type`. */
export const SECRET_PARAMETER = /password|secret|credential/i;

/** Fields of a secret parameter that are only labels, kept as they are. */
const LABELS = new Set(['_class', 'name', 'type', 'description']);

const empty = (v: unknown) => v === null || v === undefined || v === '';

/** A copy of a Jenkins response with secret parameter values masked: every field but the labels of an object
 * whose `_class` or `type` names a secret parameter, and the value of a build parameter without `_class`
 * (its type unknown, so treated as secret). Build parameter values are no key name core can mask. */
export function maskParameterSecrets(value: unknown): unknown {
  const walk = (v: unknown, inParameters: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, inParameters));
    if (!isPlainObject(v)) return v;
    const cls = typeof v._class === 'string' ? v._class : undefined;
    const secret =
      (cls !== undefined && SECRET_PARAMETER.test(cls)) ||
      (typeof v.type === 'string' && SECRET_PARAMETER.test(v.type));
    const untyped = inParameters && cls === undefined;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (secret && !LABELS.has(k)) return [k, empty(x) ? x : REDACTED];
        if (untyped && k === 'value') return [k, empty(x) ? x : REDACTED];
        return [k, walk(x, k === 'parameters')];
      }),
    );
  };
  return walk(value, false);
}

/** `https://user:token@host/…` → `https://[REDACTED]@host/…`: credentials embedded in a URL. */
export const maskUrlCredentials = (text: string) =>
  text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`);

/** Environment maps (EnvInject `envMap`, `environment`) hold whatever a build exports, secrets included. */
const ENVIRONMENT = new Set(['envMap', 'environment']);

/** A copy with URL credentials masked in every string and environment maps hidden, whatever `tree` or
 * `depth` selected (git `remoteUrls`, SCM URLs, injected environments). */
export function maskEmbeddedCredentials(value: unknown): unknown {
  if (typeof value === 'string') return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map(maskEmbeddedCredentials);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, ENVIRONMENT.has(k) && !empty(v) ? REDACTED : maskEmbeddedCredentials(v)]),
  );
}
