// PostToolUse hook: runs Prettier on the file just edited, so `pnpm format:check` in CI stays green.
// Prettier skips files in .prettierignore and unknown types; a failure here never blocks the edit.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { tool_input: toolInput = {}, cwd } = JSON.parse(input || '{}');
const root = process.env.CLAUDE_PROJECT_DIR ?? cwd ?? process.cwd();
const prettier = path.join(root, 'node_modules/.bin/prettier');
const file = toolInput.file_path;

if (file && existsSync(file) && existsSync(prettier)) {
  try {
    execFileSync(prettier, ['--write', '--ignore-unknown', '--log-level=warn', file], { cwd: root, stdio: 'ignore' });
  } catch {
    // A file Prettier can't parse is left as written; lint and format:check will report it.
  }
}
