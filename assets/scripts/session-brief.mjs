#!/usr/bin/env node
// Printed at SessionStart. Reads HANDOFF.md from the repository root.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LINES = 60;
const path = join(process.cwd(), 'HANDOFF.md');

if (!existsSync(path)) {
  process.stdout.write('harness-kit: no HANDOFF.md in this repository yet.\n');
  process.exit(0);
}

let text = '';
try { text = readFileSync(path, 'utf8'); } catch {
  process.stdout.write('harness-kit: HANDOFF.md could not be read.\n');
  process.exit(0);
}

const lines = text.split('\n');
const shown = lines.slice(0, MAX_LINES);
process.stdout.write('--- HANDOFF.md ---\n' + shown.join('\n') + '\n');
if (lines.length > MAX_LINES) {
  process.stdout.write(`--- truncated: ${lines.length - MAX_LINES} more lines in HANDOFF.md ---\n`);
}
