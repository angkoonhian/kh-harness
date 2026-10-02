import { typescriptSingle, typescriptWorkspace } from './typescript.mjs';
import { python } from './python.mjs';
import { generic } from './generic.mjs';

const ALL = [typescriptWorkspace, typescriptSingle, python];

export function selectProfile(stack) {
  let best = null, score = 0;
  for (const p of ALL) {
    const c = p.confidence(stack);
    if (c > score) { score = c; best = p; }
  }
  if (!best || score < 0.5) return generic;
  // Bind the stack so callers need only pass a package.
  return { ...best, commands: pkg => best.commands(pkg, stack) };
}
