// PreToolUse hook: stops edits to generated files and asks before edits to the signing key.
// Reads the tool call from stdin; prints a permission decision for matching paths, nothing otherwise.
import path from 'node:path';

const RULES = [
  {
    match: /(^|\/)pnpm-lock\.yaml$/,
    decision: 'deny',
    reason: 'pnpm-lock.yaml is generated. Change package.json and run `pnpm install` instead.',
  },
  {
    match: /^plugins\/[^/]+\/dist\//,
    decision: 'deny',
    reason: 'dist/ is the esbuild bundle. Edit src/ and run `pnpm --filter ./plugins/<id> build`.',
  },
  {
    match: /^minisign\.pub$/,
    decision: 'ask',
    reason:
      'minisign.pub is the key every Synoikia install pins for this repository. Changing it blocks installs until each admin confirms the new key; only for a compromised key.',
  },
];

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { tool_input: toolInput = {}, cwd } = JSON.parse(input || '{}');
const file = toolInput.file_path ?? toolInput.notebook_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? cwd ?? process.cwd();
const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
const rule = RULES.find((r) => r.match.test(rel));
if (!rule) process.exit(0);

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: rule.decision,
      permissionDecisionReason: `${rel}: ${rule.reason}`,
    },
  }),
);
