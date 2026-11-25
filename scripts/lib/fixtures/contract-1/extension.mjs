// .claude/acme-lockfile/guard.mjs: a kh-harness contract 1 PreToolUse
// extension. One self-contained file; it imports Node built-ins only.
import { basename } from 'node:path';

const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

export function preToolUse(payload) {
  const file = payload.tool_input?.file_path;
  if (EDITING_TOOLS.has(payload.tool_name) && typeof file === 'string' && basename(file) === 'package-lock.json') {
    return { decision: 'block', message: 'package-lock.json is written by npm install; do not edit it by hand.' };
  }
  return { decision: 'allow' };
}
