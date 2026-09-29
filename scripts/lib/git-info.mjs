// scripts/lib/git-info.mjs
import { execFileSync } from 'node:child_process';

export function gitInfo(root) {
  try {
    const branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { isRepo: true, branch: branch === 'HEAD' ? null : branch };
  } catch {
    return { isRepo: false, branch: null };
  }
}
