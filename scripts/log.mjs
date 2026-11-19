#!/usr/bin/env node
// scripts/log.mjs
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { LOG_USAGE, parseArgv, wantsHelp, warnUnknown } from './lib/cli.mjs';
import {
  disableLog, enableLog, logCommand, logStatus, maintainLog, purgeLog, purgeTarget,
  renderDisable, renderEnable, renderMaintain, renderPurgePlan, renderStatus,
} from './lib/log-lib.mjs';
import { isEnabled } from '../assets/scripts/harness-log.mjs';

const KNOWN_FLAGS = new Set(['--yes', '--json', '--help', '-h']);

// Each flag means something to one subcommand only; elsewhere it is said to
// be ignored, as an unknown flag is.
const FLAG_OWNER = { '--yes': 'purge', '--json': 'status' };

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(LOG_USAGE + '\n');
  process.exit(0);
}

const { flags, positionals, unknown } = parseArgv(argv, KNOWN_FLAGS);
warnUnknown(unknown);

const usage = 'usage: log <repo-path> <enable|disable|status|maintain|purge> [--yes] [--json]   (--help for the full contract)';
const fail = (code, message) => {
  process.stderr.write(`kh-harness: ${message}\n`);
  process.exit(code);
};

const [target, subcommand, ...extra] = positionals;
if (target === undefined || subcommand === undefined) fail(2, usage);
if (extra.length > 0) fail(2, `unexpected argument(s): ${extra.join(' ')}\n${usage}`);

const say = text => process.stdout.write(text + '\n');

const SUBCOMMANDS = {
  enable(root) {
    let enabled;
    try {
      enabled = enableLog(root);
    } catch (error) {
      fail(2, `could not enable the log (${error?.code ?? error?.message ?? 'unknown error'}); nothing is recorded.`);
    }
    say(renderEnable(enabled));
  },
  disable(root) {
    let disabled;
    try {
      disabled = disableLog(root);
    } catch (error) {
      fail(2, `could not disable the log (${error?.code ?? error?.message ?? 'unknown error'}); it may still be recording.`);
    }
    say(renderDisable(root, disabled));
  },
  status(root) {
    const status = logStatus(root);
    say(flags.has('--json') ? JSON.stringify(status, null, 2) : renderStatus(status));
  },
  maintain(root) {
    if (!isEnabled(root)) fail(3, `the log is not enabled for ${root} on this machine; nothing was done. Enable it first: ${logCommand(root, 'enable')}`);
    const result = maintainLog(root);
    say(renderMaintain(result));
    if (result.lockLost) process.exit(2);
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
      fail(2, `could not remove ${plan.dir} (${error?.code ?? error?.message ?? 'unknown error'}); what remains is still there, and \`status\` says whether the log is still enabled.`);
    }
    say(`Removed ${plan.dir}. The log for this repository on this machine is gone, and disabled.`);
  },
};

if (!Object.hasOwn(SUBCOMMANDS, subcommand)) fail(2, `unknown subcommand: ${subcommand}\n${usage}`);

for (const [flag, owner] of Object.entries(FLAG_OWNER)) {
  if (flags.has(flag) && owner !== subcommand) process.stderr.write(`kh-harness: ${flag} applies only to ${owner}; ignored.\n`);
}

const root = resolve(target);
if (!existsSync(root)) fail(2, `no such path: ${root}`);

SUBCOMMANDS[subcommand](root);
