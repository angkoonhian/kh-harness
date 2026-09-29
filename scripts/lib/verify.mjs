import { execSync } from 'node:child_process';
import { join } from 'node:path';

const KINDS = ['build', 'test', 'lint', 'typecheck']; // install is never run: it mutates the tree

export function defaultRun(root, dir, command) {
  const started = Date.now();
  try {
    execSync(command, { cwd: join(root, dir), stdio: 'ignore', timeout: 10 * 60 * 1000 });
    return { exitCode: 0, durationMs: Date.now() - started };
  } catch (err) {
    return { exitCode: typeof err?.status === 'number' ? err.status : 1, durationMs: Date.now() - started };
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
      try { r = exec(command, pkg.dir); } catch { r = { exitCode: 1, durationMs: 0 }; }
      out.push({ pkg: pkg.name, kind, command, exitCode: r?.exitCode ?? 1, durationMs: r?.durationMs ?? 0 });
    }
  }
  return out;
}
