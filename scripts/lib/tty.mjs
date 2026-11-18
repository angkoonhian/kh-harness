// scripts/lib/tty.mjs
//
// The guard on every command that approves a promotion, marks a firing
// wrong, or enables or changes a promotion policy: such a command runs only
// for a person at an interactive terminal outside Claude Code, so the agent
// cannot approve its own work. This is a barrier against the ordinary case,
// not isolation: a process running as the same user can forge a terminal
// and clear the variable.

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
