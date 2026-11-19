// scripts/lib/learn-lifecycle.test.mjs — the session log and the learning
// loop end to end, in one fixture repository built step by step: install,
// sessions, a recurrence, a draft on trial, promotion, landing, a wrong
// mark, revert, uninstall and purge.
//
// Every step an owner or a hook takes goes through the real entry point as
// a child process, the hooks run from the copies `apply` installed in the
// fixture, at the paths its settings register. The steps that need a person
// at a terminal are first shown refused as a child process, which has none,
// and are then taken through the library with the result
// `requireInteractive` gives at a terminal; each such call says so. What is
// asserted is the commands' own output, `git status` and the data
// directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { LOCAL_GATES_FILE, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import { SEAL_IDLE_MS } from '../../assets/scripts/harness-seal.mjs';
import { landLearning, revertLearning } from './learn-land.mjs';
import { approveLearning, markWrong } from './learn-promote.mjs';
import {
  APPLY, DETECT, fixture, git, LEARN, LOG, manifestOf, runRegisteredHook, runResult, sandboxDataDir, UNINSTALL,
} from './lifecycle-fixtures.mjs';
import { MIN_CLEAN_CALLS, MIN_CLEAN_SESSIONS } from './replay.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';
import { requireInteractive } from './tty.mjs';

const DATA_ROOT = sandboxDataDir();
sandboxMarkerDir();

// What `requireInteractive` returns for a person at a terminal outside
// Claude Code; no child process this file spawns has one.
const AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} });

const MODEL = 'claude-opus-5';
const MISTAKE = 'npm test -- --watch';
const FIX = 'npm test';
const WATCH_ERROR = 'Error: --watch needs an interactive terminal, and none is attached';
const GATE_MESSAGE = 'Run the tests once: watch mode waits for a terminal an agent session does not have.';
const MINUTE_MS = 60_000;

// The replay's false-positive check passes only on MIN_CLEAN_CALLS Bash calls
// across MIN_CLEAN_SESSIONS sessions that hold no failure of the signature.
// The two clean sessions share that floor evenly, so the draft's replay is
// checkable with nothing to spare: one call fewer and it would not be.
const CLEAN_CALLS_PER_SESSION = Math.ceil(MIN_CLEAN_CALLS / MIN_CLEAN_SESSIONS);
const CLEAN_COMMANDS = Array.from({ length: CLEAN_CALLS_PER_SESSION }, (_, i) => `node scripts/build.mjs --part ${i + 1}`);

const owner = (d, ...a) => git(d, '-c', 'user.email=owner@example.invalid', '-c', 'user.name=owner', ...a);

/** `git status --porcelain` with every untracked file listed. */
const status = d => git(d, 'status', '--porcelain', '--untracked-files=all');

/** Every file under `dir` outside `.git`, by relative path with `/`, with
 * the SHA-256 of its bytes. */
function tree(dir) {
  const files = {};
  const walk = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(path);
      } else {
        files[relative(dir, path).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(dir);
  return files;
}

/** A kit CLI's result, asserted to have succeeded with nothing on stderr. */
function ok(result) {
  assert.equal(result.status, 0, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout;
}

/** A kit CLI's result, asserted to be the terminal refusal: exit 3 and a
 * line naming the missing terminal. */
function refusedForTerminal(result) {
  assert.equal(result.status, 3, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /interactive terminal/);
}

test('the learning loop end to end, through the real commands and the installed hooks', async t => {
  const d = fixture();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const draftDir = mkdtempSync(join(tmpdir(), 'hk-learn-life-draft-'));
  t.after(() => rmSync(draftDir, { recursive: true, force: true }));

  const learn = (...a) => runResult(LEARN, d, ...a);
  const log = (...a) => runResult(LOG, d, ...a);
  /** `detect --json`'s checks by id. The report detect writes into the
   * repository is removed again: the owner here does not keep it, so each
   * step's `git status` shows only what the loop wrote. */
  const detect = () => {
    const report = JSON.parse(ok(runResult(DETECT, d, '--json')));
    rmSync(join(d, 'docs/harness/detect.json'));
    return Object.fromEntries(report.checks.map(c => [c.id, c]));
  };
  const dataDir = repoDataDir(d);
  const localGatesPath = join(dataDir, LOCAL_GATES_FILE);
  const localGateIds = () => JSON.parse(readFileSync(localGatesPath, 'utf8')).gates.map(g => g.id ?? g.suspended);
  /** Every file under the data directory with its bytes, to show a step
   * wrote nothing there. */
  const dataSnapshot = () => tree(dataDir);

  // --- One session, as Claude Code drives the hooks -------------------------
  let toolUses = 0;
  /**
   * A session `id`: each event goes to the installed logging hook, which
   * must stay silent; before each tool call the installed gate hook is
   * asked, and its decision returned; a failed call also goes to the
   * installed loop-watch hook. A call the gate denies never runs, so it has
   * no result event.
   */
  function session(id) {
    const base = { session_id: id, cwd: d };
    const silent = (r, what) => assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' }, what);
    const logged = (event, fields) => runRegisteredHook(d, event, 'session-log.mjs', { ...base, hook_event_name: event, ...fields });
    const send = async (event, fields = {}) => silent(await logged(event, fields), `session-log on ${event}`);
    return {
      send,
      start: () => send('SessionStart', { source: 'startup', model: MODEL }),
      /** One Bash call; resolves to the gate hook's output, or null when it
       * printed nothing. Claude Code runs the hooks on one event in
       * parallel, and so does this. */
      async bash(command, { fails = false, permission = false } = {}) {
        const call = { tool_name: 'Bash', tool_input: { command, description: 'Run a command' }, tool_use_id: `toolu_${String(++toolUses).padStart(4, '0')}` };
        const [pre, g] = await Promise.all([
          logged('PreToolUse', call),
          runRegisteredHook(d, 'PreToolUse', 'tool-gate.mjs', { ...base, hook_event_name: 'PreToolUse', ...call }),
        ]);
        silent(pre, 'session-log on PreToolUse');
        assert.equal(g.status, 0, g.stderr);
        assert.equal(g.stderr, '');
        const decision = g.stdout === '' ? null : JSON.parse(g.stdout);
        if (decision?.hookSpecificOutput?.permissionDecision === 'deny') return decision;
        if (permission) await send('PermissionRequest', call);
        if (fails) {
          const failure = { ...call, error: `${WATCH_ERROR}\n    at watch (node_modules/vitest/dist/cli.js:42:7)` };
          const [post, watch] = await Promise.all([
            logged('PostToolUseFailure', failure),
            runRegisteredHook(d, 'PostToolUseFailure', 'loop-watch.mjs', { ...base, hook_event_name: 'PostToolUseFailure', ...failure }),
          ]);
          silent(post, 'session-log on PostToolUseFailure');
          silent(watch, 'loop-watch on one failure');
        } else {
          await send('PostToolUse', { ...call, tool_response: { stdout: 'done', stderr: '', interrupted: false, isImage: false } });
        }
        return decision;
      },
      /** Ends the turn and the session as Claude Code does, then ages the
       * session's file past the idle threshold: the log seals a session at
       * the next session start once it has been idle `SEAL_IDLE_MS`, and
       * this stands in for the time between two sessions. */
      async end() {
        await send('Stop', { stop_hook_active: false });
        await send('SessionEnd', { reason: 'other' });
        const file = join(dataDir, 'sessions', sessionFileName(id));
        const at = new Date(Date.now() - SEAL_IDLE_MS - MINUTE_MS);
        utimesSync(file, at, at);
      },
    };
  }

  /** A session that runs the mistaken command, then the corrected one. */
  async function mistakeThenFix(id) {
    const s = session(id);
    await s.start();
    await s.send('UserPromptSubmit', { prompt: 'run the tests and fix what fails' });
    const mistake = await s.bash(MISTAKE, { fails: true });
    const fix = await s.bash(FIX);
    await s.end();
    return { mistake, fix };
  }

  /** The firings `learn show L1` lists, `{ sessionId, line, action, marked }`
   * each, `sessionId` and `line` as `wrong` takes them. */
  function shownFirings() {
    const lines = ok(learn('show', 'L1')).split('\n');
    const heading = lines.findIndex(l => /^ {2}firings, .*, each as `wrong` takes it:$/.test(l));
    if (heading === -1) return [];
    return lines.slice(heading + 1).filter(l => /^ {4}\S/.test(l)).map(l => {
      const [ref, action, at, marked] = l.trim().split('  ');
      assert.match(at, /^at \d{4}-\d\d-\d\dT[\d:.]+Z$/, l);
      const colon = ref.lastIndexOf(':');
      return { sessionId: ref.slice(0, colon), line: Number(ref.slice(colon + 1)), action, marked: marked === 'marked wrong' };
    });
  }

  /** How `log report` counts L1's firings: per action, and how many of its
   * warnings and blocks were followed by a successful call of the tool. */
  function reportedFirings() {
    const gate = JSON.parse(ok(log('report', '--json'))).gates.firings.find(g => g.gateId === 'L1');
    return gate === undefined ? null : { fired: gate.fired, rerouted: gate.rerouted };
  }

  let beforeTree, signature, sha256;

  await t.test('1. a repository on a feature branch with one commit', () => {
    assert.equal(git(d, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git(d, 'branch', '--show-current').trim(), 'chore/harness');
    assert.equal(status(d), '', 'fixture sanity: the tree is clean');
    beforeTree = tree(d);
    assert.deepEqual(Object.keys(beforeTree).sort(), ['.claude/settings.json', 'package.json', 'tsconfig.json']);
  });

  await t.test('2. apply --yes installs the hooks; detect reports the gate, the log and integrity as a fresh install has them', () => {
    const out = ok(runResult(APPLY, d, '--yes'));
    for (const script of ['session-log.mjs', 'tool-gate.mjs', 'loop-watch.mjs', 'harness-log.mjs', 'harness-seal.mjs', 'harness-gates.mjs']) {
      assert.match(out, new RegExp(`^wrote {6}\\.claude/scripts/${script.replace('.', '\\.')}$`, 'm'), script);
    }
    const checks = detect();
    assert.equal(checks['P5.toolgate'].state, 'declared');
    assert.deepEqual(checks['P5.toolgate'].evidence, ['PreToolUse hook: .claude/scripts/tool-gate.mjs']);
    assert.equal(checks['P5.sessionlog'].state, 'declared');
    assert.match(checks['P5.sessionlog'].evidence[0], /is registered on all 16 logged events/);
    assert.equal(checks['P2.loopwatch'].state, 'declared');
    assert.equal(checks['P5.integrity'].state, 'declared');
    assert.match(checks['P5.integrity'].evidence[0], /^\d+ harness files recorded in \.claude\/kh-harness\.manifest\.json match it$/);
    assert.deepEqual(checks['P5.integrity'].evidence.slice(1), ['.claude/kh-harness/gates.json: no committed gate file']);
    // The owner reviews the install and commits it.
    owner(d, 'add', '-A');
    owner(d, 'commit', '-q', '-m', 'install kh-harness');
    assert.equal(status(d), '');
  });

  await t.test('3. the log is off until enabled, and enabling it writes nothing in the repository', () => {
    const installed = tree(d);
    assert.match(ok(log('status')), /^No log for this repository on this machine: .+ does not exist\.$/m);
    assert.match(ok(log('enable')), /^The session log is enabled for .+ on this machine\.$/m);
    const enabled = ok(log('status'));
    assert.match(enabled, /^ {2}enabled: yes$/m);
    assert.match(enabled, /^ {2}the hook is registered in \.claude\/settings\.json$/m);
    assert.equal(status(d), '');
    assert.deepEqual(tree(d), installed);
  });

  await t.test('4. sessions: the same call fails the same way in two of them, and two are clean', async () => {
    // The first session carries every event a session can send beside its
    // tool calls; the gate hook has nothing to say yet.
    const a = session('session-a');
    await a.start();
    await a.send('InstructionsLoaded', { file_path: join(d, 'HANDOFF.md'), memory_type: 'Project', load_reason: 'session_start' });
    await a.send('UserPromptSubmit', { prompt: 'run the tests and fix what fails' });
    assert.equal(await a.bash(MISTAKE, { fails: true }), null);
    assert.equal(await a.bash(FIX, { permission: true }), null);
    await a.send('SubagentStart', { agent_id: 'agent-1', agent_type: 'Explore' });
    await a.send('SubagentStop', { agent_id: 'agent-1', agent_type: 'Explore', stop_hook_active: false });
    await a.send('PreCompact', { trigger: 'auto' });
    await a.send('PostCompact', { trigger: 'auto' });
    await a.end();

    const b = session('session-b');
    await b.start();
    await b.send('UserPromptSubmit', { prompt: 'the tests are failing again' });
    assert.equal(await b.bash(MISTAKE, { fails: true }), null);
    await b.send('PermissionDenied', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' }, tool_use_id: 'toolu_denied', reason: 'destructive command' });
    assert.equal(await b.bash(FIX), null);
    await b.send('StopFailure', { error: 'rate_limit', error_details: 'retry later' });
    await b.send('UserPromptSubmit', { prompt: 'go on' });
    await b.end();

    // Two clean sessions at once, as in two terminals.
    await Promise.all(['session-c', 'session-d'].map(async (id, i) => {
      const s = session(id);
      await s.start();
      await s.send('UserPromptSubmit', { prompt: 'build every part' });
      for (const command of CLEAN_COMMANDS) assert.equal(await s.bash(command), null);
      if (i === 1) await s.send('PostModelSwitch', { from_model: MODEL, to_model: 'claude-sonnet-5', source: 'command' });
      await s.end();
    }));
    // The clean sessions' starts sealed the two before them; they wait for
    // the next session start.
    assert.match(ok(log('status')), /^ {2}sessions: 4.*; sealed: 2, with events not yet sealed: 2$/m);
  });

  await t.test('5. log report shows one recurrence over two sessions, and learn candidates lists it, unlabelled', () => {
    const report = JSON.parse(ok(log('report', '--json')));
    const recurrences = report.groups.flatMap(g => g.recurrences);
    assert.equal(recurrences.length, 1, JSON.stringify(report.groups));
    const [r] = recurrences;
    assert.equal(r.tool, 'Bash');
    assert.deepEqual(r.sessions, ['session-a', 'session-b']);
    assert.deepEqual(r.failureKinds, []);
    assert.equal(r.count, 2);
    assert.equal(r.errorLine, WATCH_ERROR);
    assert.deepEqual(report.gates.firings, [], 'no gate exists yet');
    signature = r.signature;
    const text = ok(log('report'));
    assert.match(text, new RegExp(`^ {4}${signature} {2}Bash: in 2 sessions, 2 times, from `, 'm'), text);
    assert.match(text, /^ {6}failure kind: unlabelled$/m);
    // Listed under the recurrences that may be drafted, and none apart as
    // rejected before.
    const candidates = ok(learn('candidates'));
    const draftable = candidates.slice(candidates.indexOf('RECURRENCES NO LEARNING STANDS FOR (each may be drafted)'), candidates.indexOf('RECURRENCES DRAFTED BEFORE'));
    assert.match(draftable, new RegExp(`^ {4}${signature} {2}Bash: in 2 sessions, 2 times, from `, 'm'), candidates);
    assert.match(draftable, /^ {6}failure kind: unlabelled$/m);
    assert.match(candidates, /^RECURRENCES DRAFTED BEFORE, .*\n {2}none found$/m);
  });

  await t.test('6. the owner names the failure in docs/harness/FAILURES.md, and log report shows the kind', () => {
    // The test stands in for the owner, writing the entry the scaffold's
    // FORMAT describes below its comment.
    appendFileSync(join(d, 'docs/harness/FAILURES.md'), `\n## F1 — The tests are started in watch mode\n- signatures: ${signature}\n`);
    owner(d, 'commit', '-q', '-a', '-m', 'name failure F1');
    assert.match(ok(log('report')), new RegExp(`^ {4}${signature} .*\\n.*\\n {6}failure kind: F1$`, 'm'));
    assert.deepEqual(JSON.parse(ok(log('report', '--json'))).groups[0].recurrences[0].failureKinds, ['F1']);
  });

  await t.test('7. evidence shows both calls; a draft from a file replays to a pass and goes on trial at observe; git status is unchanged', () => {
    const evidence = ok(learn('evidence', signature));
    const lines = evidence.split('\n').map(l => l.trim());
    const begin = lines.findIndex(l => l.startsWith('BEGIN RECORDED DATA '));
    const nonce = lines[begin]?.split(' ')[3]?.replace(/:$/, '');
    const end = lines.indexOf(`END RECORDED DATA ${nonce}`);
    assert.ok(begin !== -1 && end > begin, evidence);
    const data = lines.slice(begin + 1, end);
    const failing = `input: ${JSON.stringify({ command: MISTAKE, description: 'Run a command' })}`;
    const corrected = `input: ${JSON.stringify({ command: FIX, description: 'Run a command' })}`;
    assert.equal(data.filter(l => l === failing).length, 2, evidence);
    assert.equal(data.filter(l => l === corrected).length, 2, evidence);

    const path = join(draftDir, 'draft.json');
    writeFileSync(path, JSON.stringify({
      signature,
      title: 'Tests run once, never in watch mode',
      why: 'Watch mode waits for a terminal that an agent session does not have.',
      // The narrowest pattern that catches the failing input and not the
      // corrected one: the failing command itself.
      gate: { tool: 'Bash', field: 'command', match: { kind: 'literal', value: MISTAKE }, message: GATE_MESSAGE },
    }));
    const committed = status(d);
    const drafted = ok(learn('draft', '--from', path)).split('\n');
    sha256 = /^draft: stored as L1, a candidate; gate sha256 ([0-9a-f]{64})$/.exec(drafted[0])?.[1];
    assert.ok(sha256, drafted.join('\n'));
    // The replay's own account: the clean history meets the floors.
    assert.equal(drafted[1], `replay: pass: "the gate fired on all 2 mistakes, on none of 2 successful calls that followed them, and on none of ${MIN_CLEAN_CALLS} calls of the gate's tool in ${MIN_CLEAN_SESSIONS} sessions with no failure of this signature"`);
    assert.match(drafted[2], /^status: trial; its gate is in this machine's local gate set at observe, where it blocks nothing\./);
    assert.equal(status(d), committed);
    assert.equal(committed, '');

    const list = ok(learn('list'));
    assert.match(list, new RegExp(`^ {2}L1 {2}trial {2}observe {2}sha256 ${sha256}$`, 'm'), list);
    assert.match(list, /^ {6}replay: pass$/m, list);
    assert.match(list, /^ {2}approvals: none$/m, list);
    const show = ok(learn('show', 'L1'));
    assert.match(show, /^ {2}status: trial; the ledger vouches for it$/m, show);
    assert.match(show, new RegExp(`^ {2}gateSha256: ${sha256}$`, 'm'), show);
    assert.match(show, /^ {6}"action": "observe"$/m, show);
    assert.match(show, /^ {2}replay: pass: /m, show);
    assert.match(show, /^ {2}stats: fired 0 times in 0 sessions;/m, show);
    assert.deepEqual(localGateIds(), ['L1']);
  });

  await t.test('8. on trial, the mistake is allowed and recorded as one firing', async () => {
    const decisions = await mistakeThenFix('session-e');
    assert.equal(decisions.mistake, null, 'observe blocks nothing and tells nobody');
    assert.equal(decisions.fix, null);
    assert.deepEqual(reportedFirings(), { fired: { observe: 1, warn: 0, block: 0 }, rerouted: 0 });
    assert.match(ok(learn('show', 'L1')), /^ {2}stats: fired 1 time in 1 session;/m);
    assert.deepEqual(shownFirings().map(f => [f.sessionId, f.action]), [['session-e', 'observe']]);
  });

  await t.test('9. a second draft for the same recurrence is refused', () => {
    const path = join(draftDir, 'second.json');
    writeFileSync(path, JSON.stringify({
      signature,
      title: 'Never watch the tests',
      why: 'The same failure, drafted again.',
      gate: { tool: 'Bash', field: 'command', match: { kind: 'token', value: '--watch' }, message: GATE_MESSAGE },
    }));
    const data = dataSnapshot();
    const r = learn('draft', '--from', path);
    assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr },
      { status: 2, stdout: '', stderr: 'kh-harness: draft: signature: learning L1 already covers this signature\n' });
    assert.deepEqual(dataSnapshot(), data, 'the refused draft stored nothing');
  });

  await t.test('10. approve is refused without a terminal; through the library, at a terminal, L1 is active at block', () => {
    const data = dataSnapshot();
    refusedForTerminal(learn('approve', 'L1', '--sha256', sha256, '--action', 'block'));
    assert.deepEqual(dataSnapshot(), data, 'the refused approval wrote nothing');
    // A library call: approval needs a person at a terminal, which no child
    // process has.
    const approved = approveLearning(d, 'L1', { sha256, action: 'block', interactive: AT_TERMINAL });
    assert.equal(approved.ok, true, approved.error);
    const list = ok(learn('list'));
    assert.match(list, new RegExp(`^ {2}L1 {2}active-local {2}block {2}sha256 ${sha256}$`, 'm'), list);
    assert.match(list, new RegExp(`^ {4}L1 sha256 ${sha256} at block, approved by owner at \\S+Z$`, 'm'), list);
    assert.match(list, /^ {2}local gate entries above observe that no approval grants: none$/m, list);
  });

  await t.test('11. promoted, the gate hook denies the mistake with its message and allows the fix', async () => {
    const s = session('session-f');
    await s.start();
    await s.send('UserPromptSubmit', { prompt: 'run the tests' });
    const denied = await s.bash(MISTAKE, { fails: true });
    assert.deepEqual(denied, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `kh-harness gate L1: ${GATE_MESSAGE}` } });
    assert.equal(await s.bash(FIX), null);
    await s.end();
    // The block was followed by the corrected call, which succeeded.
    assert.deepEqual(reportedFirings(), { fired: { observe: 1, warn: 0, block: 1 }, rerouted: 1 });
  });

  await t.test('12. tick repairs nothing legitimate, and removes a local gate the ledger does not vouch for', () => {
    const gates = readFileSync(localGatesPath, 'utf8');
    const quiet = ok(learn('tick'));
    for (const line of [
      'promoted: none', 'demoted, back to trial with the gate at observe: none', 'suspended, a committed gate switched off on this machine: none',
      'retired, every cited path gone: none', 'local gates no approval granted, removed: none', 'local gate entries brought into line with the ledger: none',
    ]) assert.ok(quiet.split('\n').includes(`  ${line}`), `${line}\n${quiet}`);
    assert.match(quiet, /^NOT DONE\n {2}nothing$/m, quiet);
    assert.equal(readFileSync(localGatesPath, 'utf8'), gates, 'the approved gate is left as it was');
    assert.match(ok(learn('list')), /^ {2}L1 {2}active-local {2}block /m);

    // A gate no learning stands for, at block, planted in this machine's
    // gate file by something other than the loop.
    const file = JSON.parse(gates);
    file.gates.push({ id: 'L7', tool: 'Bash', field: 'command', match: { kind: 'literal', value: 'git push' }, action: 'block', message: 'Planted.' });
    writeFileSync(localGatesPath, JSON.stringify(file));
    assert.match(ok(learn('list')), /^ {2}local gate entries above observe that no approval grants: L7$/m);
    const repaired = ok(learn('tick'));
    assert.match(repaired, /^ {2}local gates no approval granted, removed: L7$/m, repaired);
    assert.match(repaired, /^NOT DONE\n {2}nothing$/m, repaired);
    assert.deepEqual(localGateIds(), ['L1']);
    assert.deepEqual(JSON.parse(readFileSync(localGatesPath, 'utf8')).gates, JSON.parse(gates).gates, 'the approved gate remains as it was');
  });

  await t.test('13. land: the dry run shows the diffs of the two files it writes; --yes needs a terminal; landed, exactly those two and the manifest change', () => {
    // The dry run shows the diffs `apply` shows: the two files the land
    // writes. The manifest is the kit's record of its writes, which `apply`
    // shows no diff of either.
    const plan = ok(learn('land', 'L1'));
    assert.deepEqual(plan.split('\n').filter(l => /^--- \S+ {2}\[/.test(l)), [
      '--- docs/harness/LEARNED.md  [P5.toolgate]',
      '--- .claude/kh-harness/gates.json  [P5.toolgate]',
    ], plan);
    assert.match(plan, /^\+ +"value": "npm test -- --watch"$/m, plan);
    assert.match(plan, /^\+ +"action": "block"$/m, plan);
    assert.match(plan, /^Dry run — nothing written\./m);
    assert.equal(status(d), '');
    refusedForTerminal(learn('land', 'L1', '--yes'));
    assert.equal(status(d), '');
    // A library call: landing writes the repository, which takes a person at
    // a terminal, which no child process has.
    const landed = landLearning(d, 'L1', { yes: true, interactive: AT_TERMINAL });
    assert.equal(landed.ok, true, landed.error);
    assert.equal(landed.status, 'landed');
    assert.deepEqual(status(d).split('\n').filter(Boolean).sort(), [
      ' M .claude/kh-harness.manifest.json',
      '?? .claude/kh-harness/gates.json',
      '?? docs/harness/LEARNED.md',
    ]);
    const checks = detect();
    assert.equal(checks['P5.integrity'].state, 'declared', JSON.stringify(checks['P5.integrity'].evidence));
    assert.ok(checks['P5.integrity'].evidence.includes('.claude/kh-harness/gates.json: 1 gate, each approved in docs/harness/LEARNED.md'), JSON.stringify(checks['P5.integrity'].evidence));
    assert.match(ok(learn('list')), new RegExp(`^ {2}L1 {2}landed {2}block {2}sha256 ${sha256}$`, 'm'));
    owner(d, 'add', '-A');
    owner(d, 'commit', '-q', '-m', 'land L1');
  });

  await t.test('14. with the gate committed, the mistake is still denied, and the local gate file no longer carries it', async () => {
    assert.deepEqual(localGateIds(), []);
    const decisions = await mistakeThenFix('session-g');
    assert.deepEqual(decisions.mistake, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `kh-harness gate L1: ${GATE_MESSAGE}` } });
    assert.equal(decisions.fix, null);
    assert.deepEqual(reportedFirings(), { fired: { observe: 1, warn: 0, block: 2 }, rerouted: 2 });
  });

  await t.test('15. two wrong marks suspend the gate on this machine; the repository is untouched and the hook allows the call', async () => {
    // The owner reads the two blocks off `learn show`, named as `wrong`
    // takes them.
    const blocks = shownFirings().filter(f => f.action === 'block');
    assert.deepEqual(blocks.map(f => [f.sessionId, f.marked]), [['session-f', false], ['session-g', false]]);
    const data = dataSnapshot();
    refusedForTerminal(learn('wrong', `${blocks[0].sessionId}:${blocks[0].line}`));
    assert.deepEqual(dataSnapshot(), data, 'the refused mark wrote nothing');
    // Library calls: a wrong mark weakens a gate, which takes a person at a
    // terminal, which no child process has.
    const first = markWrong(d, blocks[0], { interactive: AT_TERMINAL });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual([first.wrong, first.status], [1, 'landed']);
    const second = markWrong(d, blocks[1], { interactive: AT_TERMINAL });
    assert.equal(second.ok, true, second.error);
    assert.deepEqual([second.wrong, second.status], [2, 'suspended']);
    assert.equal(status(d), '', 'a suspension is this machine\'s alone');
    assert.match(ok(learn('list')), /^ {2}L1 {2}suspended {2}observe /m);
    assert.deepEqual(shownFirings().filter(f => f.action === 'block').map(f => f.marked), [true, true]);
    assert.deepEqual(localGateIds(), ['L1'], 'the suspension entry');

    const s = session('session-h');
    await s.start();
    const allowed = await s.bash(MISTAKE, { fails: true });
    assert.deepEqual(allowed, { systemMessage: 'kh-harness: 1 committed gate is suspended on this machine; `learn` lists them.' }, 'allowed, and the person told why');
    await s.end();
  });

  await t.test('16. revert takes the gate out of the repository and retires the learning', () => {
    const plan = ok(learn('revert', 'L1'));
    assert.deepEqual(plan.split('\n').filter(l => /^--- \S+ {2}\[/.test(l)), [
      '--- .claude/kh-harness/gates.json  [P5.toolgate]',
      '--- docs/harness/LEARNED.md  [P5.toolgate]',
    ], plan);
    assert.match(plan, /^- +"value": "npm test -- --watch"$/m, plan);
    assert.match(plan, /^Dry run — nothing written\./m);
    assert.equal(status(d), '');
    refusedForTerminal(learn('revert', 'L1', '--yes'));
    assert.equal(status(d), '');
    // A library call: reverting writes the repository, which takes a person
    // at a terminal, which no child process has.
    const reverted = revertLearning(d, 'L1', { yes: true, interactive: AT_TERMINAL });
    assert.equal(reverted.ok, true, reverted.error);
    assert.equal(reverted.status, 'retired');
    assert.deepEqual(status(d).split('\n').filter(Boolean).sort(), [
      ' M .claude/kh-harness.manifest.json',
      ' M .claude/kh-harness/gates.json',
      ' M docs/harness/LEARNED.md',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(d, '.claude/kh-harness/gates.json'), 'utf8')).gates, []);
    assert.match(ok(learn('list')), /^ {2}L1 {2}retired /m);
    assert.deepEqual(localGateIds(), [], 'a retired learning keeps no gate here');
    const checks = detect();
    assert.equal(checks['P5.integrity'].state, 'declared', JSON.stringify(checks['P5.integrity'].evidence));
    owner(d, 'add', '-A');
    owner(d, 'commit', '-q', '-m', 'revert L1');
  });

  await t.test('17. uninstall leaves the repository as it was, but for the owner\'s failure taxonomy, and keeps the log', () => {
    const out = ok(runResult(UNINSTALL, d, '--yes'));
    assert.match(out, /docs\/harness\/FAILURES\.md/, 'it says what it kept');
    // Compared with step 1, whose commit is still the first: the working
    // tree file by file, and what git finds changed in it since that
    // commit, the four commits the owner made here aside. The difference is
    // the owner's edit of the scaffolded FAILURES.md, which uninstall keeps
    // as an edited file, and the manifest, which it keeps to record that
    // file and nothing else.
    const after = tree(d);
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(beforeTree), '.claude/kh-harness.manifest.json', 'docs/harness/FAILURES.md'].sort());
    for (const [path, hash] of Object.entries(beforeTree)) assert.equal(after[path], hash, `${path} is byte for byte as in step 1`);
    const manifest = manifestOf(d);
    assert.deepEqual(manifest.files.map(f => f.path), ['docs/harness/FAILURES.md']);
    assert.deepEqual([manifest.settingsPatches, manifest.learnings ?? []], [[], []]);
    const first = git(d, 'rev-list', '--max-parents=0', 'HEAD').trim();
    assert.equal(git(d, 'rev-list', '--count', 'HEAD').trim(), '5');
    assert.deepEqual(git(d, 'diff', '--name-status', first).split('\n').filter(Boolean), [
      'A\t.claude/kh-harness.manifest.json',
      'A\tdocs/harness/FAILURES.md',
    ]);
    assert.equal(git(d, 'ls-files', '--others'), '', 'nothing untracked');

    assert.ok(existsSync(dataDir), 'the log is kept');
    assert.match(ok(log('status')), /^ {2}sessions: 8.*; sealed: 7, with events not yet sealed: 1$/m);
    assert.match(ok(learn('list')), /^ {2}L1 {2}retired /m, 'and its ledger');
  });

  await t.test('18. log purge lists what it would remove, and with --yes removes the data directory', () => {
    const data = dataSnapshot();
    const dry = ok(log('purge'));
    assert.ok(dry.startsWith(`Would remove ${dataDir} (`), dry);
    assert.match(dry, /, 8 sessions\):$/m, dry);
    for (const entry of ['ledger.jsonl', 'learnings/', 'sessions/', 'gates.local.json', 'index.jsonl']) assert.match(dry, new RegExp(`^ {2}${entry.replace('.', '\\.')} {2}`, 'm'), entry);
    assert.deepEqual(dataSnapshot(), data, 'the dry run removed nothing');
    assert.equal(ok(log('purge', '--yes')), `Removed ${dataDir}. The log for this repository on this machine is gone, and disabled.\n`);
    assert.equal(existsSync(dataDir), false);
    assert.ok(existsSync(DATA_ROOT), 'only this repository\'s directory goes');
  });
});
