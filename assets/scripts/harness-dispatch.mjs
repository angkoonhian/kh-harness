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
// still to run still run. A half whose promise can never settle ends the
// run instead: what the halves had returned by then is written, and no half
// after it runs.
//
// Runs on every tool call, so it imports nothing and never spawns a child
// process.

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

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

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The payload on standard input, or null when it is not JSON for an object
 * that is not an array. */
export async function readPayload() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return null;
  }
  return isPlainObject(payload) ? payload : null;
}

/** True when `result` is a half result: `{ json, stderr, exitCode }` with
 * `json` an object or null, `stderr` a string and `exitCode` 0 or 2. */
const isHalfResult = result =>
  isPlainObject(result)
  && (result.json === null || isPlainObject(result.json))
  && typeof result.stderr === 'string'
  && (result.exitCode === 0 || result.exitCode === 2);

/** The results of running each of `halves` on `payload`, in order, each
 * added to `results` as its half returns it. A half that throws, returns
 * null or returns anything but a half result contributes nothing. */
export async function runHalves(payload, halves, results = []) {
  for (const { run } of halves) {
    let result;
    try {
      result = await run(payload);
    } catch {
      continue;
    }
    if (isHalfResult(result)) results.push(result);
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
 * is any, and its standard error when it is not empty. */
export function emit(combined) {
  if (combined.json !== null) process.stdout.write(JSON.stringify(combined.json) + '\n');
  if (combined.stderr !== '') process.stderr.write(combined.stderr);
}

/** Runs `halves` on the payload standard input holds, writes their
 * combined output for `event`, and returns the exit code: 0 when the payload
 * is not an object.
 *
 * Until it returns, an uncaught exception or an unhandled rejection is
 * ignored, with no stack trace, so a fault one half leaves behind (the
 * PreToolUse extensions run first, and are another plugin's code) can stop
 * neither the halves after it nor the output. An event loop left with
 * nothing to do (a half whose promise never settles, for which Node would
 * otherwise exit 13 with a warning on standard error, since each entry
 * script awaits this at its top level) writes the combined output of the
 * results gathered so far and exits with its code. A block an earlier half
 * decided therefore stands whatever a later half does. */
export async function dispatch(event, halves) {
  const results = [];
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
  process.on('beforeExit', () => process.exit(write()));
  const payload = await readPayload();
  if (payload !== null) await runHalves(payload, halves, results);
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
