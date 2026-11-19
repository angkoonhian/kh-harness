#!/usr/bin/env node
// assets/scripts/tool-gate.mjs
//
// PreToolUse hook: interprets the learned gates before every tool call. A
// gate is data (see harness-gates.mjs); no learned enforcer is code.
//
// Two gate files bind: the committed `GATES_PATH`, which binds everyone who
// has the repository, and `LOCAL_GATES_FILE` in this machine's data
// directory, which binds only this machine. The gates are tried in ascending
// order of their id's number, and only the first that matches acts:
//   - `observe` records a firing and changes nothing;
//   - `warn` leaves the call to the normal permission flow, and its message
//     reaches Claude alongside the tool's result, after the call has run;
//   - `block` denies the call with its message as the reason.
// A firing is recorded only while the session log is enabled, so with the
// log disabled an `observe` gate does nothing at all.
//
// The local file cannot weaken a committed gate unseen. A local gate with a
// committed gate's id replaces it only when it is the same rule
// (`gateSha256`, which leaves the action out) with an action at least as
// strong; any other is ignored and the committed gate stays in force. A local
// suspension of a committed gate takes effect, since the loop demotes a gate
// that way, but the person is told. Suspension is a machine-local act, so a
// suspension in the committed file is a rejected entry.
//
// The text shown to Claude is the fixed prefix `kh-harness gate <id>: ` and
// the gate's message, which `parseGates` validates again here because the
// files can be edited by hand.
//
// Fails open, visibly: a gate file that exists but cannot be read, is larger
// than GATE_FILE_MAX_BYTES or cannot be parsed, or that holds rejected
// entries, leaves the call allowed and the rest of the gates in force. The
// person (never the model) is told in fixed sentences, each once per session,
// naming the file and a count; nothing from a gate file is copied into them.
// A sibling module that is missing or too old to provide what this hook uses
// means no gate applies, and the person is told so on every call. A missing
// gate file is normal and silent.
//
// Runs before every tool call, so it reads the two files, parses and matches,
// and never spawns a child process. Always exits 0: unparseable stdin, a
// payload for another event or without a tool name, and any internal failure
// are all nothing to do.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported in dependency order, so a missing module is named rather than the
// module that imports it.
const SIBLINGS = [
  ['./harness-redact.mjs', ['markerPath', 'projectRoot', 'safeSessionId']],
  ['./harness-log.mjs', ['appendEvent', 'GATES_PATH', 'isEnabled', 'LOCAL_GATES_FILE', 'repoDataDir']],
  ['./harness-gates.mjs', ['gateSha256', 'matchGate', 'parseGates']],
];

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports one kept or modified, run `uninstall --yes` and then `apply --yes`.';

/** The exports this hook uses, or `{ problem }` naming the first sibling that
 * could not provide them. */
async function loadSiblings() {
  const loaded = {};
  for (const [specifier, names] of SIBLINGS) {
    const shown = `.claude/scripts/${specifier.slice(2)}`;
    let module;
    try {
      module = await import(specifier);
    } catch {
      return { problem: `${shown} is missing or cannot be loaded` };
    }
    if (names.some(name => !(name in module))) return { problem: `${shown} is older than this hook and lacks what it needs` };
    for (const name of names) loaded[name] = module[name];
  }
  return { loaded };
}

const siblings = await loadSiblings();
const lib = siblings.loaded ?? {};

export const GATES_PATH = lib.GATES_PATH;
export const LOCAL_GATES_FILE = lib.LOCAL_GATES_FILE;

const HOOK_EVENT = 'PreToolUse';

/** Above this a gate file is not read: `GATE_LIMITS.gatesMax` gates fit in
 * far less, and the file is read before every tool call. */
const GATE_FILE_MAX_BYTES = 1024 * 1024;

const ACTION_RANK = { observe: 0, warn: 1, block: 2 };

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

const plural = (n, one, many) => (n === 1 ? one : many);
const unusable = label => ({ gates: [], suspended: [], problem: `${label} could not be read, so none of its gates apply.` });

/**
 * The gates and suspensions in the file `locate()` names, and the fixed
 * sentence that says what in it could not be used, or null when everything
 * could. A missing file is an empty set with nothing to say; anything that
 * throws, finding the file included, makes it unreadable.
 */
function loadGateFile(locate, label, { suspensionsAllowed }) {
  try {
    const path = locate();
    let size;
    try {
      size = statSync(path).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return { gates: [], suspended: [], problem: null };
      return unusable(label);
    }
    if (size > GATE_FILE_MAX_BYTES) return unusable(label);
    const { gates, suspended, rejected } = lib.parseGates(readFileSync(path, 'utf8'));
    if (rejected.some(r => r.index < 0)) return { gates: [], suspended: [], problem: `${label} could not be parsed, so none of its gates apply.` };
    const n = rejected.length + (suspensionsAllowed ? 0 : suspended.length);
    const problem = n === 0 ? null
      : `${n} ${plural(n, 'entry', 'entries')} in ${label} ${plural(n, 'was', 'were')} rejected and ${plural(n, 'does', 'do')} not apply; its other gates do.`;
    return { gates, suspended: suspensionsAllowed ? suspended : [], problem };
  } catch {
    return unusable(label);
  }
}

const idNumber = gate => Number(gate.id.slice(1));

/** A local gate may stand in for a committed one only as the same rule with
 * an action at least as strong. */
const mayReplace = (local, committed) =>
  lib.gateSha256(local) === lib.gateSha256(committed) && ACTION_RANK[local.action] >= ACTION_RANK[committed.action];

/** The gates in force, in the order they are tried, and how many local
 * entries were ignored or suspended a committed gate. */
function gatesInForce(committed, local) {
  const byId = new Map(committed.gates.map(g => [g.id, g]));
  let ignored = 0;
  for (const g of local.gates) {
    const theirs = byId.get(g.id);
    if (theirs === undefined || mayReplace(g, theirs)) byId.set(g.id, g);
    else ignored++;
  }
  let suspended = 0;
  for (const id of local.suspended) if (byId.delete(id)) suspended++;
  return { gates: [...byId.values()].sort((a, b) => idNumber(a) - idNumber(b)), ignored, suspended };
}

/**
 * True when this session has not been told `sentence` yet. The marker is an
 * exclusive create, so one of several parallel calls wins. A marker that
 * cannot be made means the sentence is given anyway: a repeated notice costs
 * less than a problem nobody hears about.
 */
function firstTelling(root, sessionId, sentence) {
  const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
  const path = sessionId === null ? null : lib.markerPath(root, sessionId, `tool-gate-notice-${tag}`);
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function recordFiring(root, sessionId, gate, payload) {
  if (sessionId === null) return;
  try {
    if (!lib.isEnabled(root)) return;
    lib.appendEvent(root, sessionId, {
      type: 'gate_firing',
      gateId: gate.id,
      gateSha256: lib.gateSha256(gate),
      action: gate.action,
      tool: payload.tool_name,
      tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
      session_id: sessionId,
    });
  } catch {
    // an unrecorded firing must not stop the gate acting
  }
}

/** The hook's JSON output for a tool call, or null to print nothing. */
function decide(root, payload) {
  if (payload === null || typeof payload !== 'object' || payload.hook_event_name !== HOOK_EVENT) return null;
  const { tool_name: toolName, tool_input: toolInput } = payload;
  if (typeof toolName !== 'string') return null;
  const sessionId = lib.safeSessionId(payload.session_id);

  const committed = loadGateFile(() => join(root, GATES_PATH), COMMITTED, { suspensionsAllowed: false });
  const local = loadGateFile(() => join(lib.repoDataDir(root), LOCAL_GATES_FILE), LOCAL, { suspensionsAllowed: true });
  const { gates, ignored, suspended } = gatesInForce(committed, local);

  const sentences = [committed.problem, local.problem];
  if (ignored > 0) {
    sentences.push(`${ignored} ${plural(ignored, 'entry', 'entries')} in ${LOCAL} tried to replace a committed gate with a weaker or different rule and ${plural(ignored, 'was', 'were')} ignored.`);
  }
  if (suspended > 0) {
    sentences.push(`${suspended} committed ${plural(suspended, 'gate is', 'gates are')} suspended on this machine; \`learn\` lists them.`);
  }
  const notice = sentences.filter(s => s !== null && firstTelling(root, sessionId, s));
  const output = notice.length > 0 ? { systemMessage: `kh-harness: ${notice.join(' ')}` } : {};

  const gate = gates.find(g => lib.matchGate(g, toolName, toolInput));
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
  if (siblings.problem !== undefined) {
    process.stdout.write(JSON.stringify({ systemMessage: `kh-harness gate hook: ${siblings.problem}, so no gate applies — ${REMEDY}` }) + '\n');
    return;
  }
  const output = decide(lib.projectRoot(), payload);
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
