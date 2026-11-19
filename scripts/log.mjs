#!/usr/bin/env node
// scripts/log.mjs
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { LOG_USAGE, parseArgv, wantsHelp, warnUnknown } from './lib/cli.mjs';
import {
  assertDataDirSafe, checkDataDir, DataDirRefused, disableLog, enableLog, logStatus, renderDisable, renderEnable, renderStatus,
} from './lib/log-lib.mjs';
import { maintainLog, renderMaintain } from './lib/log-maintain.mjs';
import { purgeLog, purgeTarget, renderPurgePlan } from './lib/log-purge.mjs';
import { buildLogReport, renderReport } from './lib/log-report.mjs';

const KNOWN_FLAGS = new Set(['--yes', '--json', '--help']);

// Each flag means something to the subcommands named here only; elsewhere it
// is said to be ignored, as an unknown flag is.
const FLAG_OWNERS = { '--yes': ['purge'], '--json': ['status', 'report'] };

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(LOG_USAGE + '\n');
  process.exit(0);
}

const { flags, positionals, unknown } = parseArgv(argv, KNOWN_FLAGS);
warnUnknown(unknown);

const usage = 'usage: log <repo-path> <enable|disable|status|report|maintain|purge> [--yes] [--json]   (--help for the full contract)';
const fail = (code, message) => {
  process.stderr.write(`kh-harness: ${message}\n`);
  process.exit(code);
};
const reasonOf = error => error?.code ?? error?.message ?? 'unknown error';

const [target, subcommand, ...extra] = positionals;
if (target === undefined || subcommand === undefined) fail(2, usage);
if (extra.length > 0) fail(2, `unexpected argument(s): ${extra.join(' ')}\n${usage}`);

const say = text => process.stdout.write(text + '\n');

const SUBCOMMANDS = {
  enable(root) {
    say(renderEnable(enableLog(root)));
  },
  disable(root) {
    say(renderDisable(root, disableLog(root)));
  },
  status(root) {
    const status = logStatus(root);
    say(flags.has('--json') ? JSON.stringify(status, null, 2) : renderStatus(status));
  },
  report(root) {
    const report = buildLogReport(root);
    say(flags.has('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  },
  maintain(root) {
    if (checkDataDir(root).state === 'absent') {
      say('No log for this repository on this machine; nothing to maintain.');
      return;
    }
    assertDataDirSafe(root);
    const result = maintainLog(root);
    say(renderMaintain(result));
    if (result.stepNotDone) process.exit(2);
  },
  purge(root) {
    const plan = purgeTarget(root);
    if (plan.state === 'absent') {
      say(`No log for this repository on this machine; nothing to purge (${plan.dir} does not exist).`);
      return;
    }
    if (plan.state === 'refused') fail(3, `refusing to purge ${plan.dir}: ${plan.reason}. Nothing was removed.`);
    if (!flags.has('--yes')) {
      say(renderPurgePlan(root, plan));
      return;
    }
    try {
      purgeLog(root, plan);
    } catch (error) {
      if (error instanceof DataDirRefused) throw error;
      fail(2, `could not remove ${plan.dir} (${reasonOf(error)}); what remains is still there, and \`status\` says whether the log is still enabled.`);
    }
    say(`Removed ${plan.dir}. The log for this repository on this machine is gone, and disabled.`);
  },
};

if (!Object.hasOwn(SUBCOMMANDS, subcommand)) fail(2, `unknown subcommand: ${subcommand}\n${usage}`);

for (const [flag, owners] of Object.entries(FLAG_OWNERS)) {
  if (flags.has(flag) && !owners.includes(subcommand)) process.stderr.write(`kh-harness: ${flag} applies only to ${owners.join(' and ')}; ignored.\n`);
}

const root = resolve(target);
if (!existsSync(root)) fail(2, `no such path: ${root}`);

// The contract is exit 0, 2 or 3: a refusal is 3, and anything unexpected is
// one line and 2, never a stack trace.
try {
  SUBCOMMANDS[subcommand](root);
} catch (error) {
  if (error instanceof DataDirRefused) fail(3, `${error.message}. Nothing more was written.`);
  fail(2, `${subcommand} failed (${reasonOf(error)}).`);
}
