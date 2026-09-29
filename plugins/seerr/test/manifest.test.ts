import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSdkCompatible, parseManifest } from '@synoikia/plugin-sdk';

const raw: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

describe('seerr manifest', () => {
  it('validates against the plugin SDK schema', () => {
    const manifest = parseManifest(raw);
    expect(manifest.id).toBe('seerr');
    expect(manifest.binding.namespace).toBe('seerr');
    expect(manifest.entry).toBe('dist/index.js');
  });

  it('is compatible with the SDK version core implements', () => {
    expect(isSdkCompatible(parseManifest(raw))).toBe(true);
  });

  it('marks every credential field write-only', () => {
    const { connection, sensitiveKeys } = parseManifest(raw);
    const props = (connection.schema.properties ?? {}) as Record<string, { writeOnly?: boolean }>;
    for (const [name, ui] of Object.entries(connection.ui)) {
      if (ui.widget === 'secret') {
        expect(props[name]?.writeOnly, name).toBe(true);
        expect(sensitiveKeys, name).toContain(name);
      }
    }
  });

  it('defaults to a local user and shows only the fields for the chosen sign-in method', () => {
    const { connection } = parseManifest(raw);
    const props = connection.schema.properties as Record<string, { default?: unknown }>;
    expect(props.authMethod?.default).toBe('local');
    const shownFor = (method: string) =>
      Object.entries(connection.ui)
        .filter(([, ui]) => !ui.showWhen || ui.showWhen.in.includes(method))
        .map(([name]) => name);
    expect(shownFor('local')).toEqual(['baseUrl', 'authMethod', 'email', 'password', 'specBaseUrl']);
    expect(shownFor('apiKey')).toEqual(['baseUrl', 'authMethod', 'apiKey', 'actAsUserId', 'specBaseUrl']);
  });
});
