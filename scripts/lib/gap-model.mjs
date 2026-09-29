export const STATES = ['absent', 'declared', 'verified', 'failing', 'n/a'];

const MAX_INSTRUCTION_LINES = 150;

/**
 * Each entry describes one runbook step. `check` returns
 * { state, evidence, proposal? } — and the wrapper enforces the invariant that
 * only `absent` may carry a proposal, so no individual check can break it.
 */
// Runbook step 1 ("branch for the work") is deliberately NOT a check. Being on
// a branch is a precondition of the apply run, not a capability the repository
// lacks — modelling it as a gap makes every otherwise-complete repo on `main`
// report a proposal, which would defeat the load-bearing test. Plan 2 enforces
// it as an apply-time refusal instead.
const CHECKS = [
  {
    id: 'P0.inventory', step: 2, phase: 0,
    lookedFor: ['docs/harness/detect.json'],
    // Produced by this very run, so it is evidence by construction.
    check: () => ({ state: 'verified', evidence: ['produced by this run'] }),
  },
  {
    id: 'P0.security', step: 3, phase: 0,
    lookedFor: ['tokens in remotes, tracked files and .claude settings'],
    check: ({ exposures }) => exposures.length
      ? { state: 'failing', evidence: exposures.map(e => `${e.kind} at ${e.location}`) }
      : { state: 'verified', evidence: ['no credential patterns matched'] },
  },
  {
    id: 'P0.recon', step: 4, phase: 0,
    lookedFor: ['docs/harness/recon.md'],
    check: ({ harness }) => harness.reconPresent
      ? { state: 'declared', evidence: ['docs/harness/recon.md'] }
      : { state: 'absent', proposal: 'run the recon prompt to write docs/harness/recon.md' },
  },
  {
    id: 'P1.bootstrap', step: 5, phase: 1,
    lookedFor: ['scripts/bootstrap.sh', 'scripts/setup.sh', 'Makefile', 'justfile'],
    check: ({ harness }) => harness.bootstrap
      ? { state: 'declared', evidence: [harness.bootstrap] }
      : { state: 'absent', proposal: 'create scripts/bootstrap.sh from template' },
  },
  {
    id: 'P1.instructions', step: 6, phase: 1,
    lookedFor: ['CLAUDE.md', 'AGENTS.md'],
    check: ({ harness }) => {
      const { path, lines } = harness.instructions;
      if (!path) return { state: 'absent', proposal: 'run the instruction-file prompt to derive CLAUDE.md from recon' };
      const evidence = [`${path} (${lines} lines)`];
      if (lines > MAX_INSTRUCTION_LINES) evidence.push(`${lines} lines exceeds the ${MAX_INSTRUCTION_LINES}-line budget; prune rather than replace`);
      return { state: 'declared', evidence };
    },
  },
  {
    id: 'P1.architecture', step: 7, phase: 1,
    lookedFor: ['docs/ARCHITECTURE.md'],
    check: ({ harness }) => harness.architecture
      ? { state: 'declared', evidence: [harness.architecture] }
      : { state: 'absent', proposal: 'run the architecture prompt to write docs/ARCHITECTURE.md' },
  },
  {
    id: 'P1.pathrules', step: 7, phase: 1,
    lookedFor: ['.claude/rules/'],
    check: ({ harness }) => harness.claudeDir.rules.length
      ? { state: 'declared', evidence: harness.claudeDir.rules }
      : { state: 'absent', proposal: 'scaffold .claude/rules/ with globs derived from the workspace layout' },
  },
  {
    id: 'P2.scripts', step: 8, phase: 2,
    lookedFor: ['a lint and typecheck script in every package'],
    check: ({ stack }) => {
      const missing = stack.packages.filter(p => !p.scripts?.lint || !p.scripts?.typecheck)
        .map(p => `${p.name}: missing ${[!p.scripts?.lint && 'lint', !p.scripts?.typecheck && 'typecheck'].filter(Boolean).join(' + ')}`);
      return missing.length
        ? { state: 'absent', evidence: missing, proposal: `add lint/typecheck scripts to ${missing.length} package(s)` }
        : { state: 'declared', evidence: ['every package has lint and typecheck'] };
    },
  },
  {
    id: 'P2.sensor', step: 9, phase: 2,
    lookedFor: ['a PostToolUse hook that lints touched files'],
    check: ({ harness }) => harness.claudeDir.hooks.some(h => /lint-touched/.test(h))
      ? { state: 'declared', evidence: harness.claudeDir.hooks.filter(h => /lint-touched/.test(h)) }
      : { state: 'absent', proposal: 'install scripts/lint-touched.mjs and register a PostToolUse hook' },
  },
  {
    id: 'P2.stopgate', step: 10, phase: 2,
    lookedFor: ['a Stop hook that verifies touched files'],
    check: ({ harness }) => harness.claudeDir.hooks.some(h => /verify-touched/.test(h))
      ? { state: 'declared', evidence: harness.claudeDir.hooks.filter(h => /verify-touched/.test(h)) }
      : { state: 'absent', proposal: 'install scripts/verify-touched.mjs and register a Stop hook' },
  },
  {
    id: 'P2.protected', step: 11, phase: 2,
    lookedFor: ['deny rules in .claude/settings.json'],
    check: ({ harness }) => harness.claudeDir.settings
      ? { state: 'declared', evidence: ['.claude/settings.json'] }
      : { state: 'absent', proposal: 'create .claude/settings.json with deny rules for protected paths' },
  },
  {
    id: 'P2.langserver', step: 12, phase: 2,
    lookedFor: ['a language server for the detected stack'],
    // Whether a language server is installed is machine state, not repo state.
    check: () => ({ state: 'declared', evidence: ['not determinable from the repository; verify by hand'] }),
  },
  {
    id: 'P4.remote', step: 15, phase: 4,
    lookedFor: ['at least one git remote'],
    check: ({ harness }) => harness.remotes.length
      ? { state: 'declared', evidence: harness.remotes.map(r => r.name) }
      : { state: 'absent', proposal: 'add a git remote so the harness is backed up off this machine' },
  },
  {
    id: 'P4.continuity', step: 16, phase: 4,
    lookedFor: ['HANDOFF.md', 'a SessionStart brief hook'],
    check: ({ harness }) => {
      const brief = harness.claudeDir.hooks.some(h => /session-brief/.test(h));
      if (harness.handoff && brief) return { state: 'declared', evidence: [harness.handoff, 'session-brief hook'] };
      const need = [!harness.handoff && 'HANDOFF.md', !brief && 'session-brief hook'].filter(Boolean);
      return { state: 'absent', evidence: [`missing: ${need.join(', ')}`], proposal: `install ${need.join(' and ')}` };
    },
  },
];

export function buildGaps({ stack, harness, exposures, profile, git }) {
  const applicable = new Set(profile.appliesToSteps());
  return CHECKS.map(def => {
    if (!applicable.has(def.step)) {
      return { id: def.id, step: def.step, phase: def.phase, state: 'n/a',
        lookedFor: def.lookedFor, evidence: [`not applicable to profile ${profile.id}`], proposal: null };
    }
    const r = def.check({ stack, harness, exposures, profile, git });
    return {
      id: def.id, step: def.step, phase: def.phase,
      state: r.state, lookedFor: def.lookedFor, evidence: r.evidence ?? [],
      // The invariant, enforced centrally: only `absent` may propose.
      proposal: r.state === 'absent' ? (r.proposal ?? null) : null,
    };
  });
}
