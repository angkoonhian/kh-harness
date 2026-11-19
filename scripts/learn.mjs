#!/usr/bin/env node
// scripts/learn.mjs
//
// The `learn` command. `runLearn` is the whole of it, with the terminal
// check and the two output streams passed in: the command line below passes
// the real ones, and a test passes a check that answers as
// `requireInteractive` does for a terminal, so the handlers of the
// terminal-only subcommands are run on their success path too. No flag or
// variable reaches that parameter.
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEARN_USAGE, learnHelp, wantsHelp, warnUnknown } from './lib/cli.mjs';
import {
  asciiJson, candidatesView, evidenceView, failureLine, helpName, listView, parseFiringRef, parseLearnArgv, plural, policyFrom, policyView, readDraft,
  renderApproved, renderCandidates, renderDemoted, renderDraft, renderEvidence, renderList, renderPolicy, renderPolicyCleared, renderPolicySet,
  renderReplay, renderRepositoryDone, renderRepositoryPlan, renderRetired, renderShow, renderTick, renderWrong, resolveCommand, showView, terminalRefusal, WRITES,
} from './lib/learn-cli.mjs';
import { landLearning, revertLearning } from './lib/learn-land.mjs';
import { draftLearning, listLearnings, runTrial } from './lib/learn-lib.mjs';
import { approveLearning, clearPolicy, demoteLearning, markWrong, retireLearning, setPolicy, tick } from './lib/learn-promote.mjs';
import { assertDataDirSafe, checkDataDir } from './lib/log-lib.mjs';
import { requireInteractive as terminalCheck } from './lib/tty.mjs';

const USAGE_LINE = 'usage: learn <repo-path> <subcommand> [arguments] [--json]   (--help for the full contract)';

/** How a run ends early: thrown by `fail`, caught by `runLearn` alone. */
class Exit {
  constructor(code) {
    this.code = code;
  }
}

/**
 * Runs `learn` on `argv` and returns its exit code: 0, 2 or 3. Everything it
 * prints goes to `stdout` and `stderr`, and every terminal-only handler asks
 * `requireInteractive`, with the real streams and environment, whether it
 * may run. A refusal is 3 and anything unexpected is one line and 2, never
 * a stack trace.
 */
export function runLearn(argv, { requireInteractive, stdout, stderr }) {
  const say = text => stdout.write(text + '\n');
  const fail = (code, message) => {
    stderr.write(`kh-harness: ${message}\n`);
    throw new Exit(code);
  };
  /** The exit code of a library error: 3 where the library says it refused
   * to act, and 2 for everything else, so no error can end in 0. */
  const exitOf = result => (result.exitCode === 3 ? 3 : 2);
  /** Ends a subcommand the library refused or could not finish, with the
   * exit code the library gave the error. */
  const failWith = (name, result) => fail(exitOf(result), failureLine(name, result));

  /** Ends a terminal-only subcommand: a refusal (3) when the terminal check
   * did not pass, whatever the library returned; the library's own code when
   * it refused or could not finish; otherwise what it did. */
  const settle = (name, interactive, result, render) => {
    if (interactive.ok !== true) fail(3, terminalRefusal(name, interactive, result));
    if (result.error !== undefined) failWith(name, result);
    say(render(result));
  };

  /** Ends `land` or `revert`: a refusal (3) when the write was asked for and
   * the terminal check did not pass, whatever the library returned; the
   * library's own code when it refused or could not finish; otherwise a dry
   * run's plan, which needs no terminal, or what the write did. */
  const settleRepository = (name, command, interactive, result) => {
    const print = render => say(command.json ? asciiJson(result) : render(result));
    if (command.yes && interactive.ok !== true) fail(3, terminalRefusal(name, interactive, result));
    if (result.error !== undefined) failWith(name, result);
    if (result.dryRun === true) print(view => renderRepositoryPlan(name, command.args[0], view));
    else print(view => renderRepositoryDone(name, view));
  };

  // Each terminal-only subcommand has its own handler, which asks
  // `requireInteractive` with the real streams and environment and hands its
  // answer to the library unchanged: the library refuses anything else.
  const SUBCOMMANDS = {
    'candidates'(root, command, print) {
      print(candidatesView(root), renderCandidates);
    },
    'evidence'(root, command, print) {
      const view = evidenceView(root, command.args[0]);
      if (view.error !== undefined) failWith('evidence', view);
      print(view, renderEvidence);
    },
    'draft'(root, command) {
      const read = readDraft(command.values.get('--from'));
      if (read.error !== undefined) fail(exitOf(read), read.error);
      const drafted = draftLearning(root, read.draft, { redraft: command.redraft });
      if (drafted.error !== undefined) failWith('draft', drafted);
      const trial = runTrial(root, drafted.learning.id);
      say(renderDraft(drafted, trial));
      if (trial.error !== undefined) failWith(`replay of ${drafted.learning.id}`, trial);
    },
    'replay'(root, command) {
      const [id] = command.args;
      const trial = runTrial(root, id);
      if (trial.error !== undefined) failWith('replay', trial);
      say(renderReplay(id, trial));
    },
    'list'(root, command, print) {
      const listed = listLearnings(root);
      if (listed.error !== undefined) failWith('list', listed);
      print(listView(listed), renderList);
    },
    'show'(root, command, print) {
      const view = showView(root, command.args[0], { allFirings: command.firings });
      if (view.error !== undefined) failWith('show', view);
      print(view, renderShow);
    },
    'approve'(root, command) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const [id] = command.args;
      const sha256 = command.values.get('--sha256');
      const view = showView(root, id);
      if (view.error === undefined) say(renderShow(view));
      const result = approveLearning(root, id, { sha256, action: command.values.get('--action'), interactive });
      settle('approve', interactive, result, done => renderApproved(done, sha256));
    },
    'wrong'(root, command) {
      const firing = parseFiringRef(command.args[0]);
      if (firing === null) fail(2, `wrong needs <session>:<line>, a session id and a line number of at least 1\n${USAGE_LINE}`);
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const result = markWrong(root, firing, { interactive });
      settle('wrong', interactive, result, done => renderWrong(done, firing));
    },
    'demote'(root, command) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const [id] = command.args;
      const result = demoteLearning(root, id, { interactive });
      settle('demote', interactive, result, renderDemoted);
    },
    'retire'(root, command) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const [id] = command.args;
      const result = retireLearning(root, id, { interactive });
      settle('retire', interactive, result, renderRetired);
    },
    'land'(root, command) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const [id] = command.args;
      const result = landLearning(root, id, { yes: command.yes, interactive, allowDirty: command.allowDirty, allowDefaultBranch: command.allowDefaultBranch });
      settleRepository('land', command, interactive, result);
    },
    'revert'(root, command) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const [id] = command.args;
      const result = revertLearning(root, id, { yes: command.yes, interactive, allowDirty: command.allowDirty, allowDefaultBranch: command.allowDefaultBranch });
      settleRepository('revert', command, interactive, result);
    },
    'tick'(root, command, print) {
      const result = tick(root);
      if (result.error !== undefined) failWith('tick', result);
      print(result, renderTick);
      if (result.errors.length > 0) fail(2, `tick could not do all of its work: ${plural(result.errors.length, 'step')} not done, listed above.`);
    },
    'policy show'(root, command, print) {
      print(policyView(root), renderPolicy);
    },
    'policy set'(root, command) {
      const policy = policyFrom(command.values);
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const result = setPolicy(root, policy, { interactive });
      settle('policy set', interactive, result, done => renderPolicySet(done, policy));
    },
    'policy clear'(root) {
      const interactive = requireInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env });
      const result = clearPolicy(root, { interactive });
      settle('policy clear', interactive, result, renderPolicyCleared);
    },
  };

  try {
    const parsed = parseLearnArgv(argv);
    if (wantsHelp(argv)) {
      const name = helpName(parsed.positionals);
      say(name === null ? LEARN_USAGE : learnHelp(name));
      return 0;
    }
    const command = resolveCommand(parsed);
    if (command.error !== undefined) fail(2, `${command.error}\n${USAGE_LINE}`);
    warnUnknown(parsed.unknown);
    for (const { flag, owners } of command.ignored) stderr.write(`kh-harness: ${flag} applies only to ${owners.join(' and ')}; ignored.\n`);

    const root = resolve(command.target);
    if (!existsSync(root)) fail(2, `no such path: ${root}`);

    // A step that writes refuses a data directory `log` would refuse: one
    // that is a link, or not directly inside the data root, would have the
    // write land wherever it points. `assertDataDirSafe` throws
    // `DataDirRefused` and nothing else.
    if (WRITES.has(command.name)) {
      try {
        assertDataDirSafe(root, { absentOk: true });
      } catch (error) {
        fail(3, `${error.message}. Nothing was written.`);
      }
    }

    // `evidence` prints recorded tool inputs, so it refuses the same data
    // directories: through a link it would print whatever the link points
    // at as this repository's record.
    if (command.name === 'evidence') {
      const check = checkDataDir(root);
      if (check.state === 'refused') fail(3, `refusing to read ${check.dir}: ${check.reason}. Nothing was printed from it.`);
    }

    const print = (view, render) => say(command.json ? asciiJson(view) : render(view));
    try {
      SUBCOMMANDS[command.name](root, command, print);
    } catch (error) {
      if (error instanceof Exit) throw error;
      fail(2, `${command.name} failed (${typeof error?.code === 'string' ? error.code : 'unknown error'}).`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}

/** Whether this file is the program Node was started with. */
function isMain() {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = runLearn(process.argv.slice(2), { requireInteractive: terminalCheck, stdout: process.stdout, stderr: process.stderr });
