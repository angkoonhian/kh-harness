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
// nothing, and the halves after it still run.
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

/** The results of running each of `halves` on `payload`, in order. A half
 * that throws or returns null contributes nothing. */
export async function runHalves(payload, halves) {
  const results = [];
  for (const { run } of halves) {
    let result;
    try {
      result = await run(payload);
    } catch {
      continue;
    }
    if (result !== null && result !== undefined) results.push(result);
  }
  return results;
}

const strings = values => values.filter(value => typeof value === 'string');

/** The one output of `results` on `event`: every notice, every context and,
 * on PreToolUse, every denial reason joined in running order, the highest
 * exit code, and the standard error of each. With exit code 2 Claude Code
 * ignores standard output, so the notices and context go to standard error
 * after the rest. With one contributing half the JSON is that half's own. */
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

  const exitCode = Math.max(0, ...results.map(r => r.exitCode));
  let stderr = results.map(r => r.stderr).join('');
  if (exitCode !== 2) return { json: Object.keys(json).length === 0 ? null : json, stderr, exitCode };
  for (const text of [notices.join('\n'), contexts.join('\n')]) if (text !== '') stderr += `${text}\n`;
  return { json: null, stderr, exitCode };
}

/** Writes `combined`: its JSON and a newline to standard output when there
 * is any, and its standard error when it is not empty. */
export function emit(combined) {
  if (combined.json !== null) process.stdout.write(JSON.stringify(combined.json) + '\n');
  if (combined.stderr !== '') process.stderr.write(combined.stderr);
}

/** The half `name`: the export `exportName` of the installed `file`, which
 * `load` imports. A file that cannot be loaded or lacks the export gives a
 * fixed notice instead. */
export function half(name, file, exportName, load) {
  const notice = problem => ({
    json: { systemMessage: `kh-harness dispatch: .claude/scripts/${file} ${problem}, so the ${name} hook did not run on this event — ${REMEDY}` },
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
