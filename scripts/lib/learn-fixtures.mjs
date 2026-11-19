// scripts/lib/learn-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): the
// repositories, sessions and learnings the learn-lib and learn-promote
// suites share. Importing it points KH_DATA_DIR at a temporary directory for
// the whole test process, so nothing reads or writes the real
// `~/.claude/kh-harness`; every directory it makes is removed after the
// file's tests. Tool events are built by the logging hook's own
// `toLogEvent`, so the fields replayed are the fields the hook records.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { appendEvent, LOCAL_GATES_FILE, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { draftLearning, runTrial } from './learn-lib.mjs';
import { readLedger } from './ledger.mjs';
import { FAILURE_EVENT, findRecurrences, SUCCESS_EVENT } from './recurrence.mjs';
import { MIN_CLEAN_CALLS, MIN_CLEAN_SESSIONS } from './replay.mjs';

const made = [];
export const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-learn-data-');

export const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A repository with one commit, holding `files` (path to text). */
export function repo(files = {}) {
  const d = tempDir('hk-learn-repo-');
  execFileSync('git', ['init', '-q', d]);
  writeFileSync(join(d, 'README.md'), '# app\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

export const HARNESS = { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' };

export const MISTAKE = 'npm test --watch';
export const FIX = 'npm test';
const WATCH_ERROR = 'Error: watch mode needs a terminal';

let useCounter = 0;

/** A fresh tool use id, or other per-call id, starting with `prefix`. */
export const useId = prefix => `${prefix}-${++useCounter}`;

/** A tool event as the logging hook records it. */
export function call(type, sessionId, toolName, toolInput, toolUseId = useId('use')) {
  const outcome = type === FAILURE_EVENT ? { error: WATCH_ERROR } : { tool_response: 'done' };
  return toLogEvent({ hook_event_name: type, session_id: sessionId, tool_use_id: toolUseId, tool_name: toolName, tool_input: toolInput, ...outcome });
}

export const mistake = (sessionId, toolUseId) => call(FAILURE_EVENT, sessionId, 'Bash', { command: MISTAKE }, toolUseId);
export const success = (sessionId, command, toolUseId) => call(SUCCESS_EVENT, sessionId, 'Bash', { command }, toolUseId);
export const read = sessionId => call(SUCCESS_EVENT, sessionId, 'Read', { file_path: 'src/a.mjs' });

export function log(root, sessionId, ...events) {
  for (const event of events) assert.deepEqual(appendEvent(root, sessionId, event), { written: true });
}

/** Two sessions that hit the mistake, one fixed by the plain command. */
export function logMistakes(root) {
  log(root, 'one', HARNESS, mistake('one'), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two'), read('two'));
}

/** Just enough clean history for a replay to pass. */
export function logClean(root) {
  const ids = Array.from({ length: MIN_CLEAN_SESSIONS }, (_, i) => `clean-${i}`);
  const perSession = Math.ceil(MIN_CLEAN_CALLS / ids.length);
  for (const id of ids) log(root, id, HARNESS, ...Array.from({ length: perSession }, (_, i) => success(id, `npm run task-${i}`)));
}

/** A second recurrence, of the Read tool, in two more sessions. */
export function logReadMistakes(root) {
  for (const id of ['three', 'four']) log(root, id, HARNESS, call(FAILURE_EVENT, id, 'Read', { file_path: 'missing.txt' }));
}

export function signatureOf(root, tool = 'Bash') {
  const found = findRecurrences(root).recurrences.filter(r => r.tool === tool);
  assert.equal(found.length, 1);
  return found[0].signature;
}

export const WATCH_GATE = { tool: 'Bash', field: 'command', match: { kind: 'token', value: '--watch' }, message: 'Run the tests once; watch mode needs a terminal.' };
export const FIX_GATE = { ...WATCH_GATE, match: { kind: 'literal', value: FIX } };
export const READ_GATE = { tool: 'Read', field: 'file_path', match: { kind: 'literal', value: 'missing.txt' }, message: 'That file does not exist.' };

export const draftFor = (root, over = {}) => ({
  signature: signatureOf(root, (over.gate ?? WATCH_GATE).tool),
  title: 'Tests run once, never in watch mode',
  why: 'Watch mode waits for a terminal that an agent session does not have.',
  gate: WATCH_GATE,
  ...over,
});

/** A repository whose log holds the mistakes and, unless `clean` is false,
 * enough clean history for a pass. */
export function loggedRepo({ clean = true, files } = {}) {
  const root = repo(files);
  logMistakes(root);
  if (clean) logClean(root);
  return root;
}

export const learningFile = (root, id) => join(repoDataDir(root), 'learnings', `${id}.json`);
export const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);
export const localGates = root => JSON.parse(readFileSync(localGatesPath(root), 'utf8'));
export const writeLocalGates = (root, gates) => {
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(localGatesPath(root), JSON.stringify({ schema: 1, gates }));
};
export const kinds = root => readLedger(root).map(e => `${e.learningId}:${e.kind}`);

/** The learning `draftLearning` stores for `draftFor(root, over)`, given
 * `options`; fails the test when it refuses. */
export function drafted(root, over, options) {
  const result = draftLearning(root, draftFor(root, over), options);
  assert.ok(result.learning, result.error);
  return result.learning;
}

export const editLearning = (root, id, over) =>
  writeFileSync(learningFile(root, id), JSON.stringify({ ...JSON.parse(readFileSync(learningFile(root, id), 'utf8')), ...over }));

export function logFiring(root, sessionId, gate, toolUseId, over = {}) {
  log(root, sessionId, { type: 'gate_firing', gateId: gate.id, gateSha256: gateSha256(gate), action: gate.action, tool: gate.tool, tool_use_id: toolUseId, session_id: sessionId, ...over });
}

/** Every file under `dir` outside `.git`, with its modification time. */
export function mtimes(dir) {
  const out = {};
  const walk = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(path);
      } else {
        out[relative(dir, path)] = statSync(path).mtimeMs;
      }
    }
  };
  walk(dir);
  return out;
}

/** A repository whose Bash learning L1 is on trial, its gate citing `cites`
 * when given. */
export function trialRepo({ files, cites } = {}) {
  const root = loggedRepo({ files });
  const learning = drafted(root, cites === undefined ? {} : { gate: { ...WATCH_GATE, cites } });
  assert.equal(runTrial(root, learning.id).status, 'trial');
  return { root, learning };
}
