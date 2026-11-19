#!/usr/bin/env node
// assets/scripts/tool-gate.mjs
//
// PreToolUse hook: interprets the learned gates before every tool call. A
// gate is data (see harness-gates.mjs); no learned enforcer is code.
//
// Two gate files bind: the committed `GATES_PATH`, which binds everyone who
// has the repository, and `LOCAL_GATES_FILE` in this machine's data
// directory, which binds only this machine. A local gate replaces the
// committed gate with the same id, and a local suspension removes it. The
// gates are tried in ascending order of their id's number, and only the first
// that matches acts:
//   - `observe` records a firing and changes nothing;
//   - `warn` adds its message to Claude's context and leaves the call to the
//     normal permission flow;
//   - `block` denies the call with its message as the reason.
// A firing is recorded only while the session log is enabled, so with the
// log disabled an `observe` gate does nothing at all.
//
// The text shown to Claude is the fixed prefix `kh-harness gate <id>: ` and
// the gate's message, which `parseGates` validates again here because the
// files can be edited by hand.
//
// Fails open, visibly: a gate file that exists but cannot be read or parsed,
// or that holds rejected entries, leaves the call allowed and the valid gates
// in force, and the person (never the model) is told once per session in
// fixed text naming the file and how many entries were rejected. Nothing from
// a gate file is copied into that notice. A missing gate file is normal and
// silent.
//
// Runs before every tool call, so it reads the two files, parses and matches,
// and never spawns a child process. Always exits 0: unparseable stdin, a
// payload for another event or without a tool name, and any internal failure
// are all nothing to do.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateSha256, matchGate, parseGates } from './harness-gates.mjs';
import { appendEvent, GATES_PATH, isEnabled, LOCAL_GATES_FILE, repoDataDir } from './harness-log.mjs';
import { markerPath, projectRoot, safeSessionId } from './harness-redact.mjs';

export { GATES_PATH, LOCAL_GATES_FILE };

const HOOK_EVENT = 'PreToolUse';

// A hard ceiling on how long reading stdin may block; see lint-touched.mjs's
// STDIN_TIMEOUT_MS for why the read is asynchronous.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;

function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
    } catch {
      finish('');
    }
  });
}

const COMMITTED = `the committed gate file ${GATES_PATH}`;
const LOCAL = `this machine's gate file ${LOCAL_GATES_FILE}`;

/**
 * The gates and suspensions in the file at `path`, and the fixed sentence
 * that says what in it could not be used, or null when everything could. A
 * missing file is an empty set with nothing to say.
 */
function loadGateFile(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { gates: [], suspended: [], problem: null };
    return { gates: [], suspended: [], problem: `${label} could not be read, so none of its gates apply.` };
  }
  const { gates, suspended, rejected } = parseGates(text);
  if (rejected.some(r => r.index < 0)) {
    return { gates, suspended, problem: `${label} could not be parsed, so none of its gates apply.` };
  }
  const n = rejected.length;
  const problem = n === 0 ? null : `${n} ${n === 1 ? 'entry' : 'entries'} in ${label} ${n === 1 ? 'was' : 'were'} rejected and ${n === 1 ? 'does' : 'do'} not apply; its other gates do.`;
  return { gates, suspended, problem };
}

const idNumber = gate => Number(gate.id.slice(1));

/** The gates in force, in the order they are tried. */
function gatesInForce(committed, local) {
  const byId = new Map(committed.gates.map(g => [g.id, g]));
  for (const g of local.gates) byId.set(g.id, g);
  for (const id of local.suspended) byId.delete(id);
  return [...byId.values()].sort((a, b) => idNumber(a) - idNumber(b));
}

/**
 * True when this session has not been given the notice yet. The marker is an
 * exclusive create, so one of several parallel calls wins. A marker that
 * cannot be made means the notice is given anyway: a repeated notice costs
 * less than a damaged gate file nobody hears about.
 */
function firstNotice(root, sessionId) {
  const path = sessionId === null ? null : markerPath(root, sessionId, 'tool-gate-notice');
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function recordFiring(root, sessionId, gate, payload) {
  if (sessionId === null || !isEnabled(root)) return;
  appendEvent(root, sessionId, {
    type: 'gate_firing',
    gateId: gate.id,
    gateSha256: gateSha256(gate),
    action: gate.action,
    tool: payload.tool_name,
    tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
    session_id: sessionId,
  });
}

/** The hook's JSON output for a tool call, or null to print nothing. */
function decide(root, payload) {
  if (payload === null || typeof payload !== 'object' || payload.hook_event_name !== HOOK_EVENT) return null;
  const { tool_name: toolName, tool_input: toolInput } = payload;
  if (typeof toolName !== 'string') return null;
  const sessionId = safeSessionId(payload.session_id);

  const committed = loadGateFile(join(root, GATES_PATH), COMMITTED);
  const local = loadGateFile(join(repoDataDir(root), LOCAL_GATES_FILE), LOCAL);
  const output = {};

  const problems = [committed.problem, local.problem].filter(p => p !== null);
  if (problems.length > 0 && firstNotice(root, sessionId)) {
    output.systemMessage = `kh-harness: ${problems.join(' ')}`;
  }

  const gate = gatesInForce(committed, local).find(g => matchGate(g, toolName, toolInput));
  if (gate !== undefined) {
    recordFiring(root, sessionId, gate, payload);
    const text = `kh-harness gate ${gate.id}: ${gate.message}`;
    if (gate.action === 'block') {
      output.hookSpecificOutput = { hookEventName: HOOK_EVENT, permissionDecision: 'deny', permissionDecisionReason: text };
    } else if (gate.action === 'warn') {
      // No `permissionDecision`: `allow` would skip the permission prompt.
      output.hookSpecificOutput = { hookEventName: HOOK_EVENT, additionalContext: text };
    }
  }
  return Object.keys(output).length === 0 ? null : output;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return;
  }
  const output = decide(projectRoot(), payload);
  if (output !== null) process.stdout.write(JSON.stringify(output) + '\n');
}

/** True when this file is the process's entry point rather than an import.
 * Both sides are resolved to their real spelling, since the command line may
 * name the script through a link or a win32 short name. */
function isEntryPoint() {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await main();
  } catch {
    // never throw — a hook that breaks a session is worse than none
  }
  process.exit(0);
}
