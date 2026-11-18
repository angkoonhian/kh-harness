// scripts/lib/tty.test.mjs
//
// Every test passes fake streams and a fake environment, so none depends on
// the terminal the suite happens to run in.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requireInteractive } from './tty.mjs';

const tty = () => ({ isTTY: true });
const pipe = () => ({});

test('a TTY outside a Claude Code session is interactive', () => {
  assert.deepEqual(requireInteractive({ stdin: tty(), stdout: tty(), env: {} }), { ok: true });
});

test('a piped stdin is not interactive', () => {
  const r = requireInteractive({ stdin: pipe(), stdout: tty(), env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /standard input/);
});

test('a piped stdout is not interactive', () => {
  const r = requireInteractive({ stdin: tty(), stdout: pipe(), env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /standard output/);
});

// The variable's name and meaning were read on 2026-11-19 from
// https://code.claude.com/docs/en/env-vars: "CLAUDECODE — Set to `1` in
// subprocesses Claude Code spawns (Bash and PowerShell tools, tmux sessions,
// hook commands, status line commands, stdio MCP server subprocesses). IDE
// extensions also set this in their integrated terminals."
test('a TTY inside a Claude Code session is not interactive', () => {
  const r = requireInteractive({ stdin: tty(), stdout: tty(), env: { CLAUDECODE: '1' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /CLAUDECODE/);
});

test('CLAUDECODE set to an empty string still counts as set', () => {
  assert.equal(requireInteractive({ stdin: tty(), stdout: tty(), env: { CLAUDECODE: '' } }).ok, false);
});
