#!/usr/bin/env node
// assets/scripts/tool-gate.mjs
//
// PreToolUse hook: interprets the learned gates before every tool call. A
// gate is data (see harness-gates.mjs); no learned enforcer is code.
//
// Two gate files bind: the committed `GATES_PATH`, which binds everyone who
// has the repository, and `LOCAL_GATES_FILE` in this machine's data
// directory, which binds only this machine. Every gate in force is tried
// against the call, and every one that matches records a firing with its own
// action, so no gate hides another:
//   - `observe` records its firing and changes nothing;
//   - `warn` leaves the call to the normal permission flow, and its message
//     reaches Claude alongside the tool's result, after the call has run;
//   - `block` denies the call with its message as the reason.
// The call is denied when any matching gate blocks. The text Claude gets
// names each matching gate above `observe` on a line of its own, the blocks
// first and then the warnings, each in ascending order of the id's number,
// up to `GATE_TEXT_MAX_CHARS`; a last line counts the ones that did not fit,
// whose firings are recorded all the same. A firing is recorded only while
// the session log is enabled, so with the log disabled an `observe` gate
// does nothing at all.
//
// The local file cannot weaken a committed gate unseen. A local gate with a
// committed gate's id replaces it only when it is the same rule
// (`gateSha256`, which leaves the action out) with an action at least as
// strong; any other is ignored and the committed gate stays in force. A local
// suspension of a committed gate takes effect, since the loop demotes a gate
// that way, but the person is told. Suspension is a machine-local act, so a
// suspension in the committed file is a rejected entry.
//
// A gate's line is the fixed prefix `kh-harness gate <id>: ` and the gate's
// message, which `parseGates` validates again here because the files can be
// edited by hand.
//
// Fails open, visibly: a gate file that exists but cannot be read, is larger
// than GATE_FILE_MAX_BYTES or cannot be parsed, or that holds rejected
// entries, leaves the call allowed and the rest of the gates in force. The
// person (never the model) is told in fixed sentences, each once per session,
// naming the file and a count; nothing from a gate file is copied into them.
// A sibling module that is missing or too old to provide what this hook uses
// means no gate applies, and the person is told so once per session; only
// when harness-redact.mjs itself is the missing one, which holds the
// once-per-session marker helpers, is that notice repeated on every call. A
// missing gate file is normal and silent, and stdin that is not a PreToolUse
// payload with a tool name gets no notice of any kind.
//
// Runs before every tool call, so it reads the two files, parses and matches
// (at most `GATE_LIMITS.gatesMax` gates from each file), and never spawns a
// child process. Always exits 0: unparseable stdin, a
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

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

/** The exports this hook uses, from every sibling that provided them, and
 * `problem` naming the first sibling that could not; the ones after it are
 * not imported. */
async function loadSiblings() {
  const loaded = {};
  for (const [specifier, names] of SIBLINGS) {
    const shown = `.claude/scripts/${specifier.slice(2)}`;
    let module;
    try {
      module = await import(specifier);
    } catch {
      return { loaded, problem: `${shown} is missing or cannot be loaded` };
    }
    if (names.some(name => !(name in module))) return { loaded, problem: `${shown} is older than this hook and lacks what it needs` };
    for (const name of names) loaded[name] = module[name];
  }
  return { loaded };
}

const siblings = await loadSiblings();
const lib = siblings.loaded;
// The once-per-session markers come from harness-redact.mjs.
const canMark = 'markerPath' in lib;

export const GATES_PATH = lib.GATES_PATH;
export const LOCAL_GATES_FILE = lib.LOCAL_GATES_FILE;

const HOOK_EVENT = 'PreToolUse';

/** Above this a gate file is not read: `GATE_LIMITS.gatesMax` gates fit in
 * far less, and the file is read before every tool call. */
export const GATE_FILE_MAX_BYTES = 1024 * 1024;

const ACTION_RANK = { observe: 0, warn: 1, block: 2 };

/** The most characters of gate text one call gives Claude: a dozen messages
 * of full length, and well inside the 10,000 characters Claude Code keeps of
 * a hook's output. */
export const GATE_TEXT_MAX_CHARS = 4000;

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
    let st;
    try {
      st = statSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { gates: [], suspended: [], problem: null };
      return unusable(label);
    }
    // A pipe at the path would block the read until the hook timed out.
    if (!st.isFile() || st.size > GATE_FILE_MAX_BYTES) return unusable(label);
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

/** The gates in force, in ascending order of their id's number, which is the
 * order their firings are recorded in, and how many local entries were
 * ignored or suspended a committed gate. */
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
      agent_id: typeof payload.agent_id === 'string' ? payload.agent_id : undefined,
      session_id: sessionId,
    });
  } catch {
    // an unrecorded firing must not stop the gate acting
  }
}

/** The hook's JSON output for a tool call, or null to print nothing. */
function decide(root, payload) {
  const { tool_name: toolName, tool_input: toolInput } = payload;
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

  const matched = gates.filter(g => lib.matchGate(g, toolName, toolInput));
  for (const gate of matched) recordFiring(root, sessionId, gate, payload);
  const told = matched
    .filter(g => g.action !== 'observe')
    .sort((a, b) => ACTION_RANK[b.action] - ACTION_RANK[a.action] || idNumber(a) - idNumber(b));
  if (told.length > 0) {
    const text = toldText(told);
    output.hookSpecificOutput = told[0].action === 'block'
      ? { hookEventName: HOOK_EVENT, permissionDecision: 'deny', permissionDecisionReason: text }
      // No `permissionDecision`: `allow` would skip the permission prompt.
      : { hookEventName: HOOK_EVENT, additionalContext: text };
  }
  return Object.keys(output).length === 0 ? null : output;
}

const notShown = n => `kh-harness: ${n} more matching ${plural(n, 'gate is', 'gates are')} not shown.`;

/** One line per gate of `told`, in its order, for as many as fit in
 * `GATE_TEXT_MAX_CHARS` with the line that counts the rest, which is added
 * when any is left out. The first always fits. */
function toldText(told) {
  const lines = [];
  let used = 0;
  for (const [i, gate] of told.entries()) {
    const line = `kh-harness gate ${gate.id}: ${gate.message}`;
    const after = told.length - i - 1;
    const reserved = after > 0 ? notShown(after).length + 1 : 0;
    if (i > 0 && used + line.length + 1 + reserved > GATE_TEXT_MAX_CHARS) {
      lines.push(notShown(told.length - i));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return;
  }
  if (!isToolCall(payload)) return;
  const output = siblings.problem === undefined ? decide(lib.projectRoot(), payload) : siblingNotice(payload);
  if (output !== null) process.stdout.write(JSON.stringify(output) + '\n');
}

const isToolCall = payload =>
  payload !== null && typeof payload === 'object' && payload.hook_event_name === HOOK_EVENT && typeof payload.tool_name === 'string';

/** The notice that no gate applies because a sibling could not be loaded:
 * once per session when the marker helpers loaded, otherwise every call. */
function siblingNotice(payload) {
  const sentence = `kh-harness gate hook: ${siblings.problem}, so no gate applies — ${REMEDY}`;
  if (canMark && !firstTelling(lib.projectRoot(), lib.safeSessionId(payload.session_id), sentence)) return null;
  return { systemMessage: sentence };
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
