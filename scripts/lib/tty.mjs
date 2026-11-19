// scripts/lib/tty.mjs
//
// The guard on every command that approves a promotion, marks a firing
// wrong, weakens a gate, changes the repository's gates, or sets or
// withdraws a promotion policy. What it checks is that standard input and
// standard output are both terminals and that CLAUDECODE is unset, which is
// how the owner's own terminal looks and how a command Claude Code runs
// does not, so the agent cannot approve its own work in the ordinary case.
// It cannot tell that a person is present, and it is not isolation: a
// process running as the same user can forge a terminal and clear the
// variable.

/** What the check tests, in the words every refusal and the usage give it. */
export const TERMINAL_CHECK = 'an interactive terminal outside Claude Code (standard input and output both terminals, CLAUDECODE unset)';

/**
 * `{ ok: true }` only when standard input and standard output are both TTYs
 * and `env.CLAUDECODE` is unset; otherwise `{ ok: false, reason }` naming
 * the first condition that failed. The streams and environment are
 * parameters so a test can pass fakes.
 */
export function requireInteractive({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  if (stdin?.isTTY !== true) return { ok: false, reason: 'standard input is not an interactive terminal' };
  if (stdout?.isTTY !== true) return { ok: false, reason: 'standard output is not an interactive terminal' };
  // Claude Code sets CLAUDECODE=1 in every subprocess it spawns, and IDE
  // extensions set it in their integrated terminals
  // (https://code.claude.com/docs/en/env-vars, read 2026-11-19). Any value,
  // the empty string included, counts as set.
  if (env.CLAUDECODE !== undefined) {
    return { ok: false, reason: 'CLAUDECODE is set: this is a Claude Code session; run the command from a separate terminal' };
  }
  return { ok: true };
}
