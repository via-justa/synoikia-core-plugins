import { createHash } from 'node:crypto';
import automation from '../guides/automation.md';
import common from '../guides/common.md';
import scene from '../guides/scene.md';
import script from '../guides/script.md';

/** Best-practice guides behind attestation (HA §3.6), bundled from `guides/*.md`; the version is a
 * content hash, so editing a guide invalidates its keys. */

const compose = (text: string) => `${text.trimEnd()}\n\n${common.trim()}`;

const GUIDES: Record<string, string> = {
  automation: compose(automation),
  script: compose(script),
  scene: compose(scene),
};

/** The guide for an attestation-required operation key, or undefined. */
export function guideFor(key: string): { version: string; content: string } | undefined {
  const type = /^config\/(automation|script|scene)\/config\/(create|update)$/.exec(key)?.[1];
  const content = type ? GUIDES[type] : undefined;
  if (!content) return undefined;
  return { version: createHash('sha256').update(content).digest('hex').slice(0, 12), content };
}
