import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readIfPresent, existsAny } from './scan.mjs';
// Whole-branch review, F4: the ONE function that answers "where is this
// repository's handoff file", imported from the shared asset rather than
// kept as a second list here. The dependency runs this way round because
// `session-brief.mjs` is copied verbatim into a user's `.claude/scripts/`,
// where `harness-redact.mjs` is the only module beside it — a constant in
// `scripts/lib/` could never reach it, so the shared home has to be the
// asset. See `findHandoff`'s own comment for why the hook was widened to
// match detection rather than detection narrowed to match the hook.
import { findHandoff } from '../../assets/scripts/harness-redact.mjs';

const BOOTSTRAP_CANDIDATES = [
  'scripts/bootstrap.sh', 'scripts/bootstrap.ps1', 'scripts/setup.sh', 'scripts/setup.ps1',
  'bootstrap.sh', 'setup.sh', 'Makefile', 'Taskfile.yml', 'justfile',
];

const OTHER_EDITOR_PREFIXES = ['.cursor/rules', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules', '.clinerules', '.aider.conf.yml'];

function under(files, prefix, suffix) {
  return files.filter(f => f.startsWith(prefix) && (!suffix || f.endsWith(suffix))).sort();
}

function lineCount(text) {
  if (!text) return 0;
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.length === 0 ? 0 : t.split('\n').length;
}

// Project-scoped settings only. `~/.claude/settings.json` is deliberately not
// read: it is machine state, not repository state — the same reasoning that
// makes P2.langserver honestly `n/a`.
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

/** Parse a settings file. Never throws: missing or malformed yields null. */
function parseSettings(root, rel) {
  const text = readIfPresent(root, rel);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Every `permissions.deny` entry this repository actually has in effect, from
 * BOTH project settings files, in file order, deduplicated. Never throws: a
 * missing file, unparseable JSON, or a missing/malformed `deny` array
 * contributes nothing rather than an error.
 *
 * Whole-branch review, F8: this read `.claude/settings.json` ALONE while
 * `hookEvents`, three fields away, read `SETTINGS_FILES` — both of them. Both
 * fields answer the same question ("what is configured here"), and Claude
 * Code merges the two files, so a deny rule in the gitignored, machine-local
 * `.claude/settings.local.json` is as much in effect as one in
 * `settings.json`. The consequence of the asymmetry was measured: a user
 * keeping their deny rules in `settings.local.json` was told `P2.protected`
 * was `absent` with EMPTY evidence — the one thing that check's own comment
 * says it must always do is "name what of theirs was found instead, so
 * adding rules alongside it is never a surprise" — and `apply --yes` then
 * wrote the identical rule a second time, into the other file.
 *
 * This is also the single source for the COUNT (`denyRules`) and the
 * redacted LIST (`denyRuleList`) below, which used to parse and walk the
 * settings file twice. They are the length and the contents of one thing;
 * they cannot now report different lengths.
 */
function denyRulesInEffect(root) {
  const out = [];
  for (const rel of SETTINGS_FILES) {
    const deny = parseSettings(root, rel)?.permissions?.deny;
    if (!Array.isArray(deny)) continue;
    for (const rule of deny) if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

// Task 8b: gap-model.mjs's P2.protected used to decide `declared` from
// `denyRules > 0` alone — ANY existing deny rule, regardless of what it
// protects, satisfied the whole capability. A user who denies edits to
// their own secrets directory was told their lockfile and migrations were
// protected too. `denyRuleList`, below, gives gap-model.mjs the actual
// rule STRINGS so it can compare against what its own generator would
// produce (protected-evidence.mjs's `protectedPathCandidates`, wrapped as
// `Edit(...)`) instead of a bare count.
//
// `harness` is serialised wholesale into docs/harness/detect.json and
// printed on every run — the same reason `hookEvents` below never records
// a raw hook COMMAND, only a resolved script path. A `permissions.deny`
// rule is ordinarily a path-shaped permission pattern (the shape every
// rule this tool itself ever writes takes), but apply-lib.mjs's own
// comment on `renderSettingsDenyDiff` already flags that a `Bash(...)`
// deny rule can embed a literal credential as its argument. So each entry
// here is kept verbatim ONLY when it starts with one of the tools whose
// argument is a path, never a command or URL — `Bash(...)`, `WebFetch(...)`
// and anything unrecognised become `null`, the same "present, but not
// shown" convention `hookEvents`' unresolvable commands already use.
const DENY_RULE_SAFE_PREFIXES = ['Edit(', 'Read(', 'Write(', 'Glob(', 'Grep(', 'NotebookEdit('];

function redactDenyRule(rule) {
  return typeof rule === 'string' && DENY_RULE_SAFE_PREFIXES.some(p => rule.startsWith(p)) ? rule : null;
}

/**
 * Every `.md` rule file under `.claude/rules/`, read off DISK, recursively,
 * POSIX-relative to `root`.
 *
 * Whole-branch review, F2. This was `under(files, '.claude/rules/')` — the
 * SCAN list — while every sibling `.claude/` question in this object reads
 * the file off disk. On a workspace that gitignores `.claude/`, the scan list
 * is permanently empty there, so `detect` said `P1.pathrules absent →
 * scaffold .claude/rules/` on every run, forever, while `apply` — a second
 * later, on the same tree, with the files on disk and in its own manifest —
 * said "this repository already satisfies every applicable step". Two
 * commands of one tool contradicting each other, with a proposal that could
 * never be satisfied.
 *
 * The three hook checks were given exactly this treatment for exactly this
 * repository shape (see `registeredHook`'s "not visible to the file scan —
 * .claude/ may be gitignored" branch); `P1.pathrules` was the one that was
 * not. What drifted was never the DERIVATION — `pathrules-evidence.mjs` is
 * correctly shared with the generator — it was the other half of the
 * question, PRESENCE, which no check ever shared with anything.
 *
 * `.md` only, and that is the second half of F2: the old call passed no
 * suffix, so a stray `.DS_Store` or `.gitkeep` credited the capability.
 * Claude Code discovers only `.md` under `.claude/rules/`, and discovers it
 * recursively — hence `recursive: true`, which also preserves the old
 * prefix-match behaviour for a rule file in a subdirectory. Every other
 * `under(...)` call in this object already passed `'.md'`; `rules` was the
 * only one that did not.
 *
 * Never throws: a missing directory, `.claude/rules` present as a plain
 * file, or an unreadable directory all yield `[]`.
 */
function claudeRuleFiles(root) {
  let entries;
  try {
    entries = readdirSync(join(root, '.claude', 'rules'), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    out.push(relative(root, join(e.parentPath, e.name)).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * The script a hook command runs, resolved against the repository's file list,
 * or null when nothing resolves.
 *
 * The command string is NEVER recorded. Secrets live in a command's arguments,
 * not in a program name, and one of the two files hookEvents reads —
 * `.claude/settings.local.json` — is gitignored and on the credential
 * scanner's always-probe list precisely because it holds machine-local
 * secrets. Masking the command against a pattern list would only narrow that
 * leak: the guarantee would depend on the list being complete, and this very
 * wave fixed I1 because that list was missing a common credential shape.
 * Omission does not depend on anything.
 *
 * A token survives only if it is already a path in this repository — the same
 * resolution docPointers performs on instruction-file pointers — so nothing
 * that was not already a known filename can come out of here.
 */
function commandScript(command, files) {
  const present = new Set(files);
  for (const raw of command.split(/\s+/)) {
    const p = raw.replace(/^["']+|["']+$/g, '').split('\\').join('/').replace(/^\.\//, '');
    if (p && present.has(p)) return p;
  }
  return null;
}

/**
 * The hooks a repository has actually registered, grouped by event.
 *
 * This is the repository's own registry of what is wired up. A hook's script
 * may live anywhere — `node docs/agent-context/inject.js` is a real example —
 * so the file list under `.claude/scripts/` cannot answer whether an event is
 * covered, and a filename check can never be made adequate. Settings can.
 *
 * Shape parsed (Claude Code's):
 *   { "hooks": { "<Event>": [ { "matcher": "…", "hooks": [ { "command": "…" } ] } ] } }
 *
 * Each registered hook contributes ONE entry: its resolved script path, or
 * `null` when none resolves. The command string itself is never recorded — see
 * commandScript below. An event's entry count is therefore how many hooks are
 * wired to it, which is what the checks read.
 *
 * Never throws: a missing file, bad JSON or any malformed shape yields `{}`.
 */
function hookEvents(root, files) {
  const out = {};
  for (const rel of SETTINGS_FILES) {
    const hooks = parseSettings(root, rel)?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const matcher of Array.isArray(matchers) ? matchers : []) {
        for (const entry of Array.isArray(matcher?.hooks) ? matcher.hooks : []) {
          const command = typeof entry?.command === 'string' ? entry.command.trim() : '';
          if (!command) continue;
          (out[event] ??= []).push(commandScript(command, files));
        }
      }
    }
  }
  for (const event of Object.keys(out)) {
    const uniq = [...new Set(out[event])];
    // Resolved paths first, in a stable order; one trailing null if any hook
    // on this event could not be resolved to a path.
    out[event] = [...uniq.filter(p => p !== null).sort(), ...(uniq.includes(null) ? [null] : [])];
  }
  return out;
}

const DOC_EXTENSIONS = ['.md', '.markdown'];

// Every extension a repository plausibly writes documentation in — used only
// by projectDocs, which answers "does any documentation exist at all" for
// P1.architecture's decidability. docPointers (below) resolves paths the
// instruction file names explicitly, so it keeps the narrower DOC_EXTENSIONS:
// widening it would change what counts as a *credited pointer*, not what
// counts as *documentation existing somewhere*, which is a different question
// with a different cost to getting wrong.
const PROJECT_DOC_EXTENSIONS = ['.md', '.markdown', '.rst', '.adoc', '.txt'];

// Paths this kit itself writes or scaffolds. A pointer at one of these is the
// harness pointing at itself, not the repository pointing at its own docs.
const KIT_OUTPUT_PREFIXES = ['docs/harness/', '.claude/'];
const KIT_OUTPUT_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md', 'docs/HANDOFF.md']);

// Coordinator finding: `requirements.txt`/`constraints.txt` are Python
// dependency manifests, not documentation — this codebase already treats
// `requirements*.txt` this way (see gap-model.mjs's P1.bootstrap comment
// and protected-evidence.mjs's `pairedRequirementsFiles`, both keyed on the
// same pip naming convention). Excluding these specific, already-classified
// names is NOT narrowing `PROJECT_DOC_EXTENSIONS` by guessing an extension
// is unlikely to be docs — `.txt` stays wide for every genuinely unknown
// file. It is using a fact this project already holds about one pip-
// specific name, the same way `isKitOutput` already excludes files this
// kit itself writes. Matches both the flat form (`requirements.txt`,
// `requirements-dev.txt`) and the directory form (`requirements/base.txt`),
// same two shapes `protected-evidence.mjs`'s own regex covers.
const DEPENDENCY_MANIFEST_RE = /(^|\/)(requirements|constraints)[^/]*\.txt$|(^|\/)(requirements|constraints)\/[^/]*\.txt$/;

const isDoc = f => DOC_EXTENSIONS.some(e => f.toLowerCase().endsWith(e));
const isProjectDocShaped = f => PROJECT_DOC_EXTENSIONS.some(e => f.toLowerCase().endsWith(e)) && !DEPENDENCY_MANIFEST_RE.test(f);
const isKitOutput = f => KIT_OUTPUT_FILES.has(f) || KIT_OUTPUT_PREFIXES.some(p => f.startsWith(p));

/**
 * Every path-shaped string the instruction file mentions, before resolution.
 * Three syntaxes, all of them things a repository writes deliberately:
 *   - `@path/to/file` — Claude Code's native import syntax
 *   - `[text](path)`  — a markdown link
 *   - `` `path` ``    — an inline-code path
 *
 * No attempt is made to tell a path from prose here. Resolution against the
 * real file list does that: `npm test` and `@someone` are not files, so they
 * disappear. URLs, anchors, absolute paths and parent escapes are dropped
 * outright because they can never name something inside this repository.
 */
function mentionedPaths(text) {
  if (!text) return [];
  const out = new Set();
  const add = raw => {
    let p = String(raw).trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
    p = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return;          // https:, mailto:, …
    if (p.startsWith('/') || p.startsWith('..')) return; // outside the repository
    out.add(p);
  };
  for (const m of text.matchAll(/(?:^|[\s(<])@([^\s`'"()<>\[\],;]+)/gm)) add(m[1]);
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  return [...out];
}

/**
 * Documentation the repository points at, resolved against the file list.
 *
 * This is (a) of finding D1: read the repository's own pointer instead of
 * guessing filenames. A directory pointer (`docs/wiki/`) credits the markdown
 * it contains. Nothing is content-sniffed and no candidate name list is
 * consulted — the set of names people give an architecture document is
 * unbounded, the set of ways a repository points at its own docs is not.
 */
function docPointers(text, files) {
  const present = new Set(files);
  const out = new Set();
  for (const p of mentionedPaths(text)) {
    if (present.has(p)) {
      if (isDoc(p) && !isKitOutput(p)) out.add(p);
      continue;
    }
    const prefix = p + '/';
    for (const f of files) if (f.startsWith(prefix) && isDoc(f) && !isKitOutput(f)) out.add(f);
  }
  return [...out].sort();
}

/**
 * Every documentation-shaped file anywhere in the repository that this kit
 * did not write — not only docs/*.md.
 *
 * This answers a narrower question than docPointers: not "what does the
 * instruction file point at" but "does documentation exist at all", which is
 * what P1.architecture's decidability rests on (see gap-model.mjs). `docs/` +
 * `.md` is three filenames' worth of assumption, not an enumeration of where
 * a repository is allowed to keep its docs — wiki/, README-style trees, and
 * .rst/.adoc/.txt are all real. Getting this wrong in the other direction
 * (finding docs that are not there) is not possible — it can only ever widen
 * what is found, which can only turn a proposal into a question, never the
 * reverse.
 */
function projectDocs(files) {
  return files.filter(f => isProjectDocShaped(f) && !isKitOutput(f)).sort();
}

/**
 * Any userinfo on an http(s) remote is a credential. Both shapes count:
 * `https://user:token@host` and the single-token `https://TOKEN@host`, which
 * is the canonical one-liner in countless tutorials and was previously missed
 * because the pattern required a colon.
 *
 * Anchoring on http(s) excludes `ssh://git@github.com` and scp-style
 * `git@github.com:o/r.git`, where `git@` is a username, not a secret. The `@`
 * must sit in the authority — `[^/@\s]+` cannot cross a path separator — so a
 * repository path containing `@` is not mistaken for one.
 */
const REMOTE_CREDENTIAL = /^https?:\/\/[^/@\s]+@/i;

/** Remote URLs may embed credentials. We record only whether one is present. */
function remotes(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'remote', '-v'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const seen = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (!m) continue;
      const [, name, url] = m;
      if (!seen.has(name)) seen.set(name, { name, hasCredential: REMOTE_CREDENTIAL.test(url) });
    }
    return [...seen.values()];
  } catch { return []; }
}

export function detectHarness(root, files) {
  const claudeMd = readIfPresent(root, 'CLAUDE.md');
  const agentsMd = readIfPresent(root, 'AGENTS.md');
  const instructionsPath = claudeMd != null ? 'CLAUDE.md' : (agentsMd != null ? 'AGENTS.md' : null);
  const denyInEffect = denyRulesInEffect(root);

  return {
    instructions: { path: instructionsPath, lines: lineCount(claudeMd ?? agentsMd) },
    agentsMd: agentsMd != null ? 'AGENTS.md' : null,
    claudeDir: {
      // Task 9b, finding 6: this used to read `files` (the tracked/scan-
      // visible list) while its own siblings below — denyRules,
      // denyRuleList, hookEvents — read `.claude/settings.json` directly
      // off disk via parseSettings. Under a gitignored `.claude/`, that
      // made `settings: false` sit next to `denyRules: 2` populated from
      // the very file `settings` just denied existed — a machine-readable
      // falsehood a later tool would trust. Both booleans now come from the
      // SAME read as their siblings, so they cannot disagree with them.
      settings: parseSettings(root, '.claude/settings.json') !== null,
      localSettings: parseSettings(root, '.claude/settings.local.json') !== null,
      // Whole-branch review, F8: both of these come from the SAME read of
      // BOTH settings files now — see `denyRulesInEffect`. They are the
      // length and the contents of one list.
      denyRules: denyInEffect.length,
      denyRuleList: denyInEffect.map(redactDenyRule),
      // File inventory, scan-visible only, and deliberately left that way:
      // NOTHING decides a capability's state from any of the four below (the
      // hook events are credited from `hookEvents`, by this object's own
      // design, and `rules` — the one inventory field a check DOES read —
      // is the disk read immediately after). Widening these to a disk read
      // would buy no decision and would print the names of files a user
      // deliberately kept out of git into `docs/harness/detect.json`, which
      // IS committed. See `registeredHook`'s own comment on that discipline.
      // Checked while fixing F2, and left alone on purpose.
      hooks: under(files, '.claude/scripts/'),
      hookEvents: hookEvents(root, files),
      agents: under(files, '.claude/agents/', '.md'),
      skills: under(files, '.claude/skills/', '.md'),
      commands: under(files, '.claude/commands/', '.md'),
      // Read off disk, like every other field a check decides from — F2.
      rules: claudeRuleFiles(root),
    },
    otherEditors: files.filter(f => OTHER_EDITOR_PREFIXES.some(p => f === p || f.startsWith(p + '/'))).sort(),
    architecture: existsAny(root, ['docs/ARCHITECTURE.md', 'ARCHITECTURE.md', 'docs/architecture.md']),
    // What the repository itself points at, and what documentation exists at
    // all — so P1.architecture can tell "there is none" from "I only know
    // three filenames". See gap-model.mjs.
    docPointers: docPointers(claudeMd ?? agentsMd, files),
    projectDocs: projectDocs(files),
    // F4: the same function session-brief.mjs resolves its own path with.
    handoff: findHandoff(root),
    bootstrap: existsAny(root, BOOTSTRAP_CANDIDATES),
    gitattributes: files.includes('.gitattributes'),
    remotes: remotes(root),
  };
}
