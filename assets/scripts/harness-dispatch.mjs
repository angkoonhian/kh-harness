// assets/scripts/harness-dispatch.mjs
//
// The shared core of the three entry scripts, each registered on one
// tool-call event in place of the separate hooks it runs. An entry script
// reads the payload here once, runs each hook's exported half in order,
// combines what they returned into the one output Claude Code reads, and
// writes it.
//
// A half is loaded by the entry script, which names its file: this module
// names no sibling, so it is installed beside every entry script whatever
// halves that one runs. A half that cannot be loaded, or that lacks its
// export, gives one fixed notice on every call; a half that throws gives
// nothing, and the halves after it still run. A fault a half leaves behind
// it — an exception thrown from a callback, a rejection nobody handles —
// changes nothing: it drops no result already gathered, and the halves
// still to run still run. A half whose promise does not settle ends the run
// instead, when the event loop has nothing left to do or, if something keeps
// it busy, at `RUN_DEADLINE_MS`: what the halves had returned by then is
// written, and no half after it runs.
//
// A half that carries `unfinished` is owed an answer: when the run ends
// before it returned, when the payload could not be read in full, or when it
// throws or returns neither null nor a half result, the result
// `unfinished(cause)` builds stands in for it, with `cause` one of the fixed
// texts of `CAUSES`. So for such a half, a run cut short, by either time
// limit or by a load too heavy to finish in time, gives that result and
// never silence.
//
// The output is written through the standard output and standard error
// this module found when it was loaded, before any half ran, so a half that
// replaces `process.stdout.write` (the extensions half silences it for good
// once an extension has run) cannot silence or corrupt the output; and the
// run ends through the `process.exit` it found then, so a half that replaces
// that cannot keep the process alive.
//
// Runs on every tool call, so it imports nothing and never spawns a child
// process.

// What dispatch-pre-tool.mjs requires of this module and of
// harness-extensions.mjs, compared by value. Raise it in all three together
// whenever one of them comes to rely on a change in another.
export const LEVEL = 1;

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

// A hard ceiling on how long reading stdin may block; see lint-touched.mjs's
// STDIN_TIMEOUT_MS for why the read is asynchronous.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;

// How long a run may last before what was gathered is written regardless.
// Above the slowest a kit half takes by its own bounds, the PostToolUse
// lint half's: this read of stdin (5 s), the lint run (30 s,
// lint-touched.mjs's LINT_TIMEOUT_MS) and its kill grace (5 s), 40 s in all.
// Well under the 600 s Claude Code allows a command hook by default, after
// which it discards the output. Overridable so a test need not wait.
const RUN_DEADLINE_MS = Number(process.env.HK_RUN_DEADLINE_MS) || 120_000;

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);
const exit = process.exit.bind(process);

/** Why a half owed an answer did not give one, as `unfinished` is told. */
export const CAUSES = Object.freeze({
  deadline: 'the run reached its time limit first',
  idle: 'the run was left with nothing to wait on first',
  input: 'the hook input could not be read in full in time',
  failed: 'the extensions half failed',
});

/** Standard input as `{ text, complete }`: `complete` only when the stream
 * ended within `timeoutMs`, not when the wait gave up or the stream
 * failed. */
function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = complete => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ text: data, complete });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => finish(true));
      process.stdin.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The hook input as `{ payload, complete }`: `payload` the JSON object on
 * standard input, or null when it is not JSON for an object that is not an
 * array; `complete` whether standard input was read to its end. */
export async function readPayload() {
  const { text, complete } = await readStdin(STDIN_TIMEOUT_MS);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { payload: null, complete };
  }
  return { payload: isPlainObject(payload) ? payload : null, complete };
}

/** True when `result` is a half result: `{ json, stderr, exitCode }` with
 * `json` an object or null, `stderr` a string and `exitCode` 0 or 2. */
const isHalfResult = result =>
  isPlainObject(result)
  && (result.json === null || isPlainObject(result.json))
  && typeof result.stderr === 'string'
  && (result.exitCode === 0 || result.exitCode === 2);

/** The results of running each of `halves` on `payload`, in order, each
 * added to `results` as its half returns it, and `returned(half)` called
 * then. A half that throws, returns null or returns anything but a half
 * result contributes nothing, except that one carrying `unfinished`
 * contributes `unfinished(CAUSES.failed)` unless it returned null or a half
 * result. */
export async function runHalves(payload, halves, results = [], returned = () => {}) {
  for (const half of halves) {
    let result;
    try {
      result = await half.run(payload);
    } catch {
      result = undefined;
    }
    if (isHalfResult(result)) results.push(result);
    else if (result !== null && typeof half.unfinished === 'function') results.push(half.unfinished(CAUSES.failed));
    returned(half);
  }
  return results;
}

const strings = values => values.filter(value => typeof value === 'string');

/** The one output of `results` on `event`: every notice, every context and,
 * on PreToolUse, every denial reason joined in running order, the highest
 * exit code, and the standard error of each in order, whatever the exit
 * code. With exit code 2 Claude Code still reads the fields of valid JSON
 * and, on PostToolUse and PostToolUseFailure, shows standard error to
 * Claude, so each half's text reaches the reader it reaches when the half
 * runs alone. With one contributing half the JSON is that half's own. */
export function combine(event, results) {
  const jsons = results.map(r => r.json).filter(isPlainObject);
  const outputs = jsons.map(j => j.hookSpecificOutput).filter(isPlainObject);
  const notices = strings(jsons.map(j => j.systemMessage));
  const contexts = strings(outputs.map(o => o.additionalContext));
  const denials = event === 'PreToolUse' ? outputs.filter(o => o.permissionDecision === 'deny') : [];

  let hookSpecificOutput;
  if (denials.length > 0) {
    hookSpecificOutput = { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: strings(denials.map(o => o.permissionDecisionReason)).join('\n') };
    if (contexts.length > 0) hookSpecificOutput.additionalContext = contexts.join('\n');
  } else if (contexts.length > 0) {
    hookSpecificOutput = { hookEventName: event, additionalContext: contexts.join('\n') };
  }
  const json = {};
  if (notices.length > 0) json.systemMessage = notices.join('\n');
  if (hookSpecificOutput !== undefined) json.hookSpecificOutput = hookSpecificOutput;

  return {
    json: Object.keys(json).length === 0 ? null : json,
    stderr: results.map(r => r.stderr).join(''),
    exitCode: Math.max(0, ...results.map(r => r.exitCode)),
  };
}

/** Writes `combined`: its JSON and a newline to standard output when there
 * is any, and its standard error when it is not empty, through the streams'
 * own writes as they were when this module was loaded. */
export function emit(combined) {
  if (combined.json !== null) writeOut(JSON.stringify(combined.json) + '\n');
  if (combined.stderr !== '') writeErr(combined.stderr);
}

/** Runs `halves` on the payload standard input holds, writes their
 * combined output for `event`, and returns the exit code: 0 when the payload
 * is not an object. A half owed an answer (one carrying `unfinished`) is not
 * run on a payload that was not read in full; its `unfinished(CAUSES.input)`
 * stands in for it, and the other halves run as on any payload.
 *
 * Until it returns, an uncaught exception or an unhandled rejection is
 * ignored, with no stack trace, so a fault one half leaves behind (the
 * PreToolUse extensions run first, and are code from the repository) can stop
 * neither the halves after it nor the output. An event loop left with
 * nothing to do (a half whose promise never settles, for which Node would
 * otherwise exit 13 with a warning on standard error, since each entry
 * script awaits this at its top level) writes the combined output of the
 * results gathered so far and exits with its code, and so does reaching
 * `RUN_DEADLINE_MS`, on a timer that keeps no process alive by itself, when
 * a half that does not settle has left something that keeps the loop busy;
 * each half owed an answer that had not returned then adds its
 * `unfinished(CAUSES.idle)` or `unfinished(CAUSES.deadline)`. A block an
 * earlier half decided therefore stands whatever a later half does. */
export async function dispatch(event, halves) {
  const results = [];
  const owed = new Set(halves.filter(half => typeof half.unfinished === 'function'));
  const settle = cause => {
    for (const half of owed) results.push(half.unfinished(cause));
    owed.clear();
  };
  let written = null;
  const write = () => {
    if (written === null) {
      written = combine(event, results);
      emit(written);
    }
    return written.exitCode;
  };
  const ignore = () => {};
  process.on('uncaughtException', ignore);
  process.on('unhandledRejection', ignore);
  const abandon = cause => () => {
    settle(cause);
    exit(write());
  };
  process.on('beforeExit', abandon(CAUSES.idle));
  const deadline = setTimeout(abandon(CAUSES.deadline), RUN_DEADLINE_MS).unref();
  const { payload, complete } = await readPayload();
  if (!complete) settle(CAUSES.input);
  if (payload !== null) await runHalves(payload, halves.filter(half => complete || typeof half.unfinished !== 'function'), results, half => owed.delete(half));
  // A payload that is not an object is no tool call: nothing is owed.
  owed.clear();
  clearTimeout(deadline);
  return write();
}

/** The half `name`: the export `exportName` of the installed `file`, which
 * `load` imports. A file that cannot be loaded or lacks the export gives a
 * fixed notice instead. */
export function half(name, file, exportName, load) {
  const notice = problem => ({
    json: { systemMessage: `kh-harness dispatch: .claude/scripts/${file} ${problem}, so this entry script did not run the ${name} hook — ${REMEDY}` },
    stderr: '',
    exitCode: 0,
  });
  return {
    name,
    run: async payload => {
      let module;
      try {
        module = await load();
      } catch {
        return notice('is missing or cannot be loaded');
      }
      if (typeof module[exportName] !== 'function') return notice('is older than its entry script and lacks what it needs');
      return module[exportName](payload);
    },
  };
}
