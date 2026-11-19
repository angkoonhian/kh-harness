#!/usr/bin/env node
// scripts/learn.mjs
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { LEARN_USAGE, learnHelp, wantsHelp, warnUnknown } from './lib/cli.mjs';
import {
  asciiJson, candidatesView, evidenceView, failureLine, helpName, listView, parseFiringRef, parseLearnArgv, plural, policyFrom, policyView, readDraft,
  renderApproved, renderCandidates, renderDemoted, renderDraft, renderEvidence, renderList, renderPolicy, renderPolicyCleared, renderPolicySet,
  renderReplay, renderRetired, renderShow, renderTick, renderWrong, resolveCommand, showView, terminalRefusal, WRITES,
} from './lib/learn-cli.mjs';
import { draftLearning, listLearnings, runTrial } from './lib/learn-lib.mjs';
import { approveLearning, clearPolicy, demoteLearning, markWrong, retireLearning, setPolicy, tick } from './lib/learn-promote.mjs';
import { assertDataDirSafe, checkDataDir } from './lib/log-lib.mjs';
import { requireInteractive } from './lib/tty.mjs';

const argv = process.argv.slice(2);
const parsed = parseLearnArgv(argv);

if (wantsHelp(argv)) {
  const name = helpName(parsed.positionals);
  process.stdout.write((name === null ? LEARN_USAGE : learnHelp(name)) + '\n');
  process.exit(0);
}

const usage = 'usage: learn <repo-path> <subcommand> [arguments] [--json]   (--help for the full contract)';
const fail = (code, message) => {
  process.stderr.write(`kh-harness: ${message}\n`);
  process.exit(code);
};

const command = resolveCommand(parsed);
if (command.error !== undefined) fail(2, `${command.error}\n${usage}`);
warnUnknown(parsed.unknown);
for (const { flag, owners } of command.ignored) process.stderr.write(`kh-harness: ${flag} applies only to ${owners.join(' and ')}; ignored.\n`);

const say = text => process.stdout.write(text + '\n');
const print = (view, render) => say(command.json ? asciiJson(view) : render(view));

/** Ends a terminal-only subcommand: a refusal (3) when no person is at an
 * interactive terminal, whatever the library returned; a failure (2) when
 * the library refused or could not finish; otherwise what it did. */
const settle = (name, interactive, result, render) => {
  if (interactive.ok !== true) fail(3, terminalRefusal(name, interactive, result));
  if (result.error !== undefined) fail(2, failureLine(name, result));
  say(render(result));
};

// Each terminal-only subcommand has its own handler, which asks
// `requireInteractive` with the real streams and environment and hands its
// answer to the library unchanged: the library refuses anything else.
const SUBCOMMANDS = {
  'candidates'(root) {
    print(candidatesView(root), renderCandidates);
  },
  'evidence'(root, command) {
    const view = evidenceView(root, command.args[0]);
    if (view.error !== undefined) fail(2, failureLine('evidence', view));
    print(view, renderEvidence);
  },
  'draft'(root, command) {
    const read = readDraft(command.values.get('--from'));
    if (read.error !== undefined) fail(2, read.error);
    const drafted = draftLearning(root, read.draft);
    if (drafted.error !== undefined) fail(2, failureLine('draft', drafted));
    const trial = runTrial(root, drafted.learning.id);
    say(renderDraft(drafted, trial));
    if (trial.error !== undefined) fail(2, failureLine(`replay of ${drafted.learning.id}`, trial));
  },
  'replay'(root, command) {
    const [id] = command.args;
    const trial = runTrial(root, id);
    if (trial.error !== undefined) fail(2, failureLine('replay', trial));
    say(renderReplay(id, trial));
  },
  'list'(root) {
    const listed = listLearnings(root);
    if (listed.error !== undefined) fail(2, failureLine('list', listed));
    print(listView(listed), renderList);
  },
  'show'(root, command) {
    const view = showView(root, command.args[0]);
    if (view.error !== undefined) fail(2, failureLine('show', view));
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
    if (firing === null) fail(2, `wrong needs <session>:<line>, a session id and a line number of at least 1\n${usage}`);
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
  'tick'(root) {
    const result = tick(root);
    if (result.error !== undefined) fail(2, failureLine('tick', result));
    print(result, renderTick);
    if (result.errors.length > 0) fail(2, `tick could not do all of its work: ${plural(result.errors.length, 'step')} not done, listed above.`);
  },
  'policy show'(root) {
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

const root = resolve(command.target);
if (!existsSync(root)) fail(2, `no such path: ${root}`);

// A step that writes refuses a data directory `log` would refuse: one that
// is a link, or not directly inside the data root, would have the write land
// wherever it points. `assertDataDirSafe` throws `DataDirRefused` and
// nothing else.
if (WRITES.has(command.name)) {
  try {
    assertDataDirSafe(root, { absentOk: true });
  } catch (error) {
    fail(3, `${error.message}. Nothing was written.`);
  }
}

// `evidence` prints recorded tool inputs, so it refuses the same data
// directories: through a link it would print whatever the link points at as
// this repository's record.
if (command.name === 'evidence') {
  const check = checkDataDir(root);
  if (check.state === 'refused') fail(3, `refusing to read ${check.dir}: ${check.reason}. Nothing was printed from it.`);
}

// The contract is exit 0, 2 or 3: a refusal is 3, and anything unexpected is
// one line and 2, never a stack trace.
try {
  SUBCOMMANDS[command.name](root, command);
} catch (error) {
  fail(2, `${command.name} failed (${typeof error?.code === 'string' ? error.code : 'unknown error'}).`);
}
