// scripts/lib/lifecycle-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): the
// repositories and CLI runners the three lifecycle suites share. Split out
// in audit Tier 4 so the 1,487-line `lifecycle.test.mjs`, which bounded the
// suite's wall time on its own, could become three files that run in
// parallel.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');
export const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
export const UNINSTALL = resolve(import.meta.dirname, '..', 'uninstall.mjs');

export const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
export const run = (script, d, ...a) => execFileSync(process.execPath, [script, d, ...a], { encoding: 'utf8' });
export const settings = d => JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
export const manifestOf = d => JSON.parse(readFileSync(join(d, '.claude/kh-harness.manifest.json'), 'utf8'));

// Coordinator ruling (post-review, concern 5): credential-SHAPED fixtures are
// ASSEMBLED AT RUNTIME, never committed as literals. kh-harness's own
// `P0.security` scans tracked files for exactly these patterns, so a literal
// here makes the tool fail its own check — and a security tool that cannot be
// pointed at itself is asking for trust it has not demonstrated. The fix is
// NOT a suppression mechanism (that weakens the guard); the fixtures exist to
// exercise the detector at runtime, so they do not need to exist on disk.
// Each value is split so no single source literal matches a TOKEN_PATTERN,
// the PEM header or DB_CRED, while the joined runtime value is byte-identical
// to what the test needs.

export function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  // Deliberately NO lockfile here (unlike most other fixtures in this
  // file): Task 8b made P2.protected's `declared` state mean OUR OWN
  // derived deny rules are present, not merely that the deny array is
  // non-empty. With a lockfile present, the pre-existing unrelated rule
  // below would make P2.protected `absent` + a NEW proposal (correctly —
  // it genuinely does not protect the lockfile), and apply would then add
  // a rule of its own here, which is a real behaviour this file already
  // covers elsewhere (STOPGATE test, LOAD-BEARING-2) but would break this
  // fixture's own point: that the user's unrelated setting is left
  // completely alone because there is nothing here to propose over it.
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  // The user's own setting, which must survive every stage.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');   // not a default branch
  // P4.remote must already be satisfied — this test's stage-4 assertion
  // sweeps every P4.* check, not just the two apply actually writes, and
  // apply.mjs has no generator for P4.remote (adding a remote is not
  // something the tool can do on a user's behalf). Without one, that check
  // would stay 'absent' with a proposal forever, for a reason unrelated to
  // what this test is about.
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

/**
 * The fixture for this plan's own capabilities, walked through the same
 * nine stages the P4-only fixture above already proved the mechanism for.
 * Task 8's brief: a TypeScript WORKSPACE (P1.pathrules is decidable only
 * for one — see pathrules-evidence.mjs), with a lockfile (P1.bootstrap),
 * declared `lint` and `typecheck` scripts at the root (P2.sensor,
 * P2.stopgate), and a `prisma/migrations` directory (P2.protected evidence).
 *
 * The root package declares BOTH scripts; the one workspace MEMBER
 * (packages/api) declares NEITHER — real P2.scripts evidence (see the
 * check's "advice only" assertions below) that falls out of the same
 * fixture rather than needing a package of its own.
 *
 * Task 8b (coordinator ruling, after the original version of this fixture
 * had to seed the user's own settings AFTER the first apply): every
 * gap-model.mjs check this plan touches now credits `declared` only when
 * OUR OWN artefact is present — a specific resolved hook path, or OUR OWN
 * derived deny rules — never merely because the place it lives is
 * occupied by something of the user's. That fix is what makes the
 * coordinator's original ruling satisfiable: the fixture below seeds a
 * deny rule and a hook that are genuinely the USER'S OWN, unrelated to
 * anything this plan writes, BEFORE the first apply, and every one of
 * P2.sensor/P2.stopgate/P2.protected/P4.sessionbrief still goes through a
 * real absent -> proposal -> write -> declared cycle regardless (stage 1
 * proves each is still genuinely `absent`, not pre-satisfied by this
 * content).
 *
 * `Edit(secrets/**)` and `node my-own-thing.mjs` (my-own-thing.mjs is a
 * real tracked file, so its command resolves to a real path, exactly like
 * the brief's own `fixtureWithHook` example in task-8b-brief.md) are
 * deliberately unrelated to anything this repository's real evidence would
 * ever make THIS plan propose — proven by stage 1 below, not merely
 * asserted.
 *
 * Coordinator finding (Minor): the sibling scenario — the user's own hook
 * coexisting with ours on the SAME event, so uninstall must tell them
 * apart by hash, not position — used to be seeded on PostToolUse only.
 * The three events are not driven by identical code: P2.sensor and
 * P2.stopgate each gate `registeredHook`'s verdict behind their own
 * evidence check (`hasLintScript`/`rootVerifyScript`) before trusting it,
 * while P4.sessionbrief trusts it directly — and SessionStart is the event
 * a real user's own pre-existing automation (a startup hook) is most
 * likely to already occupy. All three events get their own unrelated
 * sibling hook now, each pointing at its own real tracked file.
 */
export function workspaceFixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-ws-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'app',
    workspaces: ['packages/*'],
    scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' },
  }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, 'packages/api'), { recursive: true });
  writeFileSync(join(d, 'packages/api/package.json'), JSON.stringify({ name: '@app/api', scripts: {} }));
  writeFileSync(join(d, 'packages/api/index.ts'), 'export const ok = true;\n');
  mkdirSync(join(d, 'prisma/migrations/0001_init'), { recursive: true });
  writeFileSync(join(d, 'prisma/migrations/0001_init/migration.sql'), '-- init\n');
  // The user's own deny rule and ONE hook per event — present from before
  // the FIRST detect/apply call, as the coordinator originally asked. None
  // of these matches anything this plan's own generators derive for this
  // repository (stage 1 proves that), so all four must survive untouched,
  // sitting beside whatever kh-harness itself adds.
  writeFileSync(join(d, 'my-own-thing.mjs'), '// the user\'s own automation, unrelated to kh-harness\n');
  writeFileSync(join(d, 'my-own-stop-thing.mjs'), '// the user\'s own Stop automation, unrelated to kh-harness\n');
  writeFileSync(join(d, 'my-own-startup-thing.mjs'), '// the user\'s own SessionStart automation, unrelated to kh-harness\n');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    permissions: { deny: ['Edit(secrets/**)'] },
    hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: 'node my-own-thing.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node my-own-stop-thing.mjs' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node my-own-startup-thing.mjs' }] }],
    },
  }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');   // not a default branch
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}


// --- Task 9b, findings 4 & 5: a complete uninstall leaves no containers
// it created, and leaves `git status` clean when settings.json existed
// before apply. A repository that starts with NO `.claude/` at all, so
// apply creates `.claude/`, `.claude/scripts/`, `scripts/` and
// `.claude/settings.json` itself from nothing.

export function freshFixtureNoClaudeDir() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-fresh-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}


export function linesAfter(out, heading) {
  const idx = out.indexOf(heading);
  if (idx === -1) return [];
  const rest = out.slice(idx + heading.length).split('\n').slice(1);
  const collected = [];
  for (const line of rest) {
    if (!line.startsWith('  ')) break;
    collected.push(line.trim());
  }
  return collected;
}

