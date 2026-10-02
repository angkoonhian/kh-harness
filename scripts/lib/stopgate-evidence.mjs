// scripts/lib/stopgate-evidence.mjs
//
// Shared by gap-model.mjs's P2.stopgate CHECK and propose.mjs's stop-gate
// GENERATOR (stopgateProposal) — same reason sensor-evidence.mjs exists for
// P2.sensor, and the same pattern Task 5 established for P1.bootstrap. The
// check used to decide `absent` + a proposal purely from whether a Stop
// hook was already registered, never checking whether the ROOT package
// declares a `typecheck` or `test` script the generated hook could
// actually run — so (again) every real Python repository (scripts: []
// always) was told a Stop gate was available, and `apply` wrote nothing.
//
// Deliberately root-only, not "any package" the way `hasLintScript` is —
// see stopgateProposal's own comment in propose.mjs for why that is not
// the same gate as the sensor's: verify-touched.mjs has no file to anchor
// on (a Stop event is not tied to any one edited file), so the ROOT
// package's own script is the only honest anchor for "the repository's own
// verification command".
//
// Returns 'typecheck' when the root package declares it (the cheaper,
// preferred command — stopgateProposal's own `reason` text depends on
// which one fired), 'test' when only that is declared, and `null` when the
// root package declares neither, or there is no root package at all.
export function rootVerifyScript(stack) {
  const rootPkg = stack.packages.find(p => p.dir === '.');
  if (!rootPkg) return null;
  if (rootPkg.scripts?.includes('typecheck')) return 'typecheck';
  if (rootPkg.scripts?.includes('test')) return 'test';
  return null;
}
