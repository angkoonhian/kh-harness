// scripts/lib/sensor-evidence.mjs
//
// Shared by gap-model.mjs's P2.sensor CHECK and propose.mjs's sensor
// GENERATOR (sensorProposal) — the same sharing pattern Task 5 established
// for P1.bootstrap (see bootstrap-install.mjs's own header comment for the
// full rationale). They used to drift: gap-model.mjs decided `absent` + a
// proposal purely from whether a PostToolUse hook was already registered in
// .claude/settings.json, never checking whether lint-touched.mjs would
// actually find a lint command to run — while propose.mjs's generator
// (correctly) refuses to propose the hook at all unless at least one
// package declares a `lint` script. Since detect-stack.mjs has no Python
// script-name convention to read, `stack.packages[].scripts` is always `[]`
// for a Python package, so this mismatched for EVERY real Python
// repository, not only contrived fixtures: `detect` advertised a sensor
// hook, `apply` silently wrote nothing.
//
// `p.scripts` is a sorted list of script NAMES, never bodies (see
// detect-stack.mjs) — reading it here never risks a credential-bearing
// script body reaching either caller.
export function hasLintScript(stack) {
  return stack.packages.some(p => p.scripts?.includes('lint'));
}
