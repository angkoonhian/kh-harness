// scripts/lib/verify.mjs — `detect --verify`: runs the commands detection
// found, to turn "declared" into "verified". Output is never captured into
// the report: a command's output is the user's and can carry anything.
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// `install` and `build` are never run: both mutate the tree. Audit Tier 2,
// finding 9: `build` on a fixture with a tsconfig and no outDir wrote 1,350
// compiled files next to their sources — in the tree `--verify` was meant to
// be inspecting.
const KINDS = ['test', 'lint', 'typecheck'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `{ exitCode, durationMs, timedOut }`. A command the bound stopped is
 * recorded as `timedOut: true` rather than as a plain failure (finding 9: it
 * used to read as `exitCode: 1`, indistinguishable from a real red run).
 * `CI=1` is set so a test runner's watch mode runs once and exits.
 * `timeoutMs` is overridable only so a test can exercise the bound in
 * milliseconds; production never passes it.
 */
export function defaultRun(root, dir, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    execSync(command, { cwd: join(root, dir), stdio: 'ignore', timeout: timeoutMs, env: { ...process.env, CI: '1' } });
    return { exitCode: 0, durationMs: Date.now() - started, timedOut: false };
  } catch (err) {
    // Node sets `code: 'ETIMEDOUT'` on exactly the timeout kill, on every
    // platform; `killed`/`signal` are set by any SIGTERM, not only ours
    // (Tier 2 review, Important 2).
    const timedOut = err?.code === 'ETIMEDOUT';
    return { exitCode: typeof err?.status === 'number' ? err.status : (timedOut ? null : 1), durationMs: Date.now() - started, timedOut };
  }
}

export function verifyCommands({ root, stack, profile, run }) {
  const exec = run ?? ((command, dir) => defaultRun(root, dir, command));
  const out = [];
  for (const pkg of stack.packages) {
    const commands = profile.commands(pkg);
    for (const kind of KINDS) {
      const command = commands[kind];
      if (!command) continue;
      let r;
      try { r = exec(command, pkg.dir); } catch { r = { exitCode: 1, durationMs: 0, timedOut: false }; }
      out.push({ pkg: pkg.name, kind, command, exitCode: r?.exitCode ?? 1, durationMs: r?.durationMs ?? 0, timedOut: r?.timedOut === true });
    }
  }
  return out;
}
