import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readIfPresent, existsAny } from './scan.mjs';
import { readJsonFile } from './read-json.mjs';
import { git, isNotRepository } from './git-info.mjs';
import { CONTRACT_FILES, installedScriptStatus, kitContractText, toolGateDenyRules } from './propose.mjs';
import { contractEvidence } from './contract.mjs';
import { KIT_VERSION } from './manifest.mjs';
// `findHandoff` is imported from the installed asset, and must not be
// copied into scripts/lib/. It answers "where is this repository's handoff
// file", and two things must answer it identically: this module, which
// credits `P4.handoff`, and `assets/scripts/session-brief.mjs`, the
// SessionStart hook that reads the file. The hook is copied into a user's
// `.claude/scripts/`, where nothing under scripts/lib/ can reach it, so the
// only possible shared home is the asset. With two copies, `detect` can
// report `P4.handoff declared / docs/HANDOFF.md` and then install a hook
// that tells every session there is no handoff file.
import { findHandoff } from '../../assets/scripts/harness-redact.mjs';
import { intentEvidence, INTENT_PATH } from './intent-evidence.mjs';
import { rulesRegistryEvidence, ruleShapedLines } from './rules-evidence.mjs';
import { failuresEvidence } from './failures-evidence.mjs';
import { extensionsEvidence } from './extensions-evidence.mjs';
import { normalizeMatcher, hookPathTokens, matcherEntrySha256, SETTINGS_PATH } from './settings-merge.mjs';

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
const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';
const SETTINGS_FILES = [SETTINGS_PATH, LOCAL_SETTINGS_PATH];

/**
 * A settings file through the shared JSON reader: `absent`, `unreadable`
 * (with a reason) or `ok`. Valid JSON that is not a plain object is
 * `unreadable` — Claude Code can no more use it than a syntax error.
 */
function readSettings(root, rel) {
  const read = readJsonFile(join(root, rel));
  if (read.state !== 'ok') return read;
  const v = read.value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? read : { state: 'unreadable', reason: 'is not a JSON object' };
}

/** A settings file's object, or null when it is absent or unreadable. Never throws. */
function parseSettings(root, rel) {
  const read = readSettings(root, rel);
  return read.state === 'ok' ? read.value : null;
}

/**
 * Every `permissions.deny` entry this repository has in effect, from both
 * project settings files, in file order, deduplicated. Never throws: a
 * missing file, unparseable JSON, or a missing or malformed `deny` array
 * contributes nothing.
 *
 * Both files, as the hook registry reads both: Claude Code merges them, so
 * a deny rule in the gitignored, machine-local `.claude/settings.local.json`
 * is as much in effect as one in `settings.json`. Read from one alone, a
 * user keeping their rules in the local file is told `P2.protected` is
 * absent with no evidence, and `apply` writes the identical rule a second
 * time into the other file.
 *
 * The one source for the count (`denyRules`) and the redacted list
 * (`denyRuleList`): they are the length and the contents of one thing.
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

// `denyRuleList` gives gap-model.mjs the rule strings, so P2.protected can
// judge what the rules cover: a bare count would let a rule denying edits
// to a secrets directory read as protecting the lockfile.
//
// `harness` is serialised whole into docs/harness/detect.json and printed
// on every run, which is why a hook is recorded by its resolved script and
// never by its command. A `permissions.deny` rule is ordinarily a
// path-shaped permission pattern, but a `Bash(...)` rule can embed a
// literal credential as its argument. So an entry is kept verbatim only
// when it starts with one of the tools whose argument is a path;
// `Bash(...)`, `WebFetch(...)` and anything unrecognised become `null`:
// present, but not shown.
const DENY_RULE_SAFE_PREFIXES = ['Edit(', 'Read(', 'Write(', 'Glob(', 'Grep(', 'NotebookEdit('];

// The rules the kit installs with its gate hook, kept verbatim so
// `P5.toolgate` can tell which are present: its command rules, against the
// `learn` subcommands and `log purge --yes`, and its rule for the data directory
// under the home directory. Only these exact strings, which the kit wrote
// and which hold nothing of the user's: any other command rule may carry an
// argument of theirs.
const KIT_DENY_RULES = new Set(toolGateDenyRules());

// A path rule whose argument starts at the filesystem root (`//`), the
// home directory (`~`) or a drive names a place on this machine, outside
// the repository: a user name, at the least. Such a rule can come from the
// gitignored settings.local.json, and the report is committed.
const OUTSIDE_REPOSITORY = /^\w+\((?:\/\/|~|[A-Za-z]:)/;

function redactDenyRule(rule) {
  if (typeof rule !== 'string') return null;
  if (KIT_DENY_RULES.has(rule)) return rule;
  return DENY_RULE_SAFE_PREFIXES.some(p => rule.startsWith(p)) && !OUTSIDE_REPOSITORY.test(rule) ? rule : null;
}

/**
 * Every `.md` rule file under `.claude/rules/`, read off DISK, recursively,
 * POSIX-relative to `root`.
 *
 * Off disk, not from the scan list, like every other `.claude/` question a
 * check decides from: on a workspace that gitignores `.claude/` the scan
 * list is empty there for good, and `detect` would propose scaffolding
 * `.claude/rules/` on every run while `apply`, on the same tree, said
 * there was nothing to do.
 *
 * `.md` only: Claude Code discovers only `.md` under `.claude/rules/`, so
 * a stray `.DS_Store` or `.gitkeep` must not credit the capability. It
 * discovers them recursively, hence `recursive: true`.
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
 * The command string is never recorded. Secrets live in a command's
 * arguments, not in a program name, and one of the two files the registry
 * is read from, `.claude/settings.local.json`, is gitignored and on the
 * credential scanner's always-probe list because it holds machine-local
 * secrets. Masking the command against a pattern list would only narrow
 * that leak, since the guarantee would depend on the list being complete.
 * Omission does not depend on anything.
 *
 * A token survives only if it is already a path in this repository — the same
 * resolution docPointers performs on instruction-file pointers — so nothing
 * that was not already a known filename can come out of here.
 */
function commandScript(entry, files) {
  const present = new Set(files);
  // Both of Claude Code's forms — exec (`args[0]`) and shell (the command's
  // tokens) — through the one normaliser the write-time dedupe uses, so a
  // `${CLAUDE_PROJECT_DIR}`-rooted path resolves to the same repository path.
  for (const p of hookPathTokens(entry)) {
    if (present.has(p)) return p;
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
 * Each registered hook contributes ONE entry: its resolved script path (or
 * `null` when none resolves) and its normalised matcher. The command string
 * itself is never recorded — see commandScript above.
 *
 * Each entry also carries `entrySha256`, the hash of the settings element
 * that holds it, computed as a hook patch records it: an entry whose script
 * cannot be resolved is still known to be the one the kit wrote when its
 * hash is the one the install record holds. It is NON-ENUMERABLE, so it
 * never reaches docs/harness/detect.json, which is committed: a hash of a
 * command that embeds a short credential can be tested against guesses.
 * `settingsFile`, also non-enumerable, names the settings file the entry is
 * in, since `apply` patches only `.claude/settings.json`.
 *
 * Never throws: a missing file, bad JSON or any malformed shape yields `{}`.
 */
function hookRegistrations(root, files) {
  const out = {};
  for (const rel of SETTINGS_FILES) {
    const hooks = parseSettings(root, rel)?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const matcher of Array.isArray(matchers) ? matchers : []) {
        // The matcher decides when a hook fires, so it is recorded beside
        // the resolved script: our per-edit sensor under `Bash` is not a
        // per-edit sensor. Normalised by the same
        // function the write-time dedupe uses. Never the command string.
        const m = normalizeMatcher(typeof matcher?.matcher === 'string' ? matcher.matcher : undefined);
        const entrySha256 = matcherEntrySha256(matcher);
        for (const entry of Array.isArray(matcher?.hooks) ? matcher.hooks : []) {
          const command = typeof entry?.command === 'string' ? entry.command.trim() : '';
          if (!command) continue;
          const registration = { script: commandScript(entry, files), matcher: m };
          Object.defineProperty(registration, 'entrySha256', { value: entrySha256, enumerable: false });
          Object.defineProperty(registration, 'settingsFile', { value: rel, enumerable: false });
          (out[event] ??= []).push(registration);
        }
      }
    }
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
const KIT_OUTPUT_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md', 'docs/HANDOFF.md', INTENT_PATH]);

// `requirements.txt` and `constraints.txt` are Python dependency
// manifests, not documentation, as protected-evidence.mjs's
// `pairedRequirementsFiles` also takes them to be. Excluding these names is
// not guessing that `.txt` is unlikely to be documentation: `.txt` stays
// wide for every unknown file. Matches the flat form (`requirements.txt`,
// `requirements-dev.txt`) and the directory form (`requirements/base.txt`).
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
const PROJECT_DOCS_LISTED = 25;

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

/** What is said, in the committed report, of a git that could not list the
 * remotes. Never git's own message, which can name an absolute path. */
function remotesFailure(err) {
  if (err?.code === 'ENOENT') return 'git is not installed or not on PATH';
  if (err?.code === 'ETIMEDOUT') return 'git did not answer in time';
  return 'git failed';
}

/**
 * `{ list, error }`: the repository's remotes, each by name and whether its
 * URL embeds a credential, which is all that is recorded of a URL; and why
 * git could not list them, or null. A directory that is not a repository has
 * none and no error. A git that could not answer is not a repository
 * without remotes.
 */
function remotes(root, env) {
  let out;
  try {
    out = git(root, ['remote', '-v'], env === undefined ? {} : { env });
  } catch (err) {
    return { list: [], error: isNotRepository(err) ? null : remotesFailure(err) };
  }
  const seen = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (!m) continue;
    const [, name, url] = m;
    if (!seen.has(name)) seen.set(name, { name, hasCredential: REMOTE_CREDENTIAL.test(url) });
  }
  return { list: [...seen.values()], error: null };
}

/** `contractEvidence` against the contract file this kit writes, with
 * `installed` mapping each of `CONTRACT_FILES` to its
 * `installedScriptStatus` unless the file was unreadable. */
function contractWithInstalled(root) {
  const contract = contractEvidence(root, kitContractText(KIT_VERSION));
  if (contract.state === 'unreadable') return contract;
  return { ...contract, installed: Object.fromEntries(CONTRACT_FILES.map(path => [path, installedScriptStatus(root, path, KIT_VERSION)])) };
}

/** `env` is overridable only so a test can take git away; production
 * callers never pass it. */
export function detectHarness(root, files, { env } = {}) {
  const claudeMd = readIfPresent(root, 'CLAUDE.md');
  const agentsMd = readIfPresent(root, 'AGENTS.md');
  const instructionsPath = claudeMd != null ? 'CLAUDE.md' : (agentsMd != null ? 'AGENTS.md' : null);
  const denyInEffect = denyRulesInEffect(root);
  const allDocs = projectDocs(files);
  const registrations = hookRegistrations(root, files);
  const remote = remotes(root, env);

  const harness = {
    instructions: { path: instructionsPath, lines: lineCount(claudeMd ?? agentsMd) },
    agentsMd: agentsMd != null ? 'AGENTS.md' : null,
    claudeDir: {
      // Read off disk, as `denyRules`, `denyRuleList` and
      // `hookRegistrations` below are: taken from the scan list, a
      // gitignored `.claude/` would put "no settings file" beside deny
      // rules read from that very file. Each is `absent`, `unreadable` or
      // `ok`: a file that is there but cannot be used must never read as a
      // file that is not there.
      settings: readSettings(root, SETTINGS_PATH).state,
      localSettings: readSettings(root, LOCAL_SETTINGS_PATH).state,
      // One read of both settings files (`denyRulesInEffect`): the length
      // and the contents of one list.
      denyRules: denyInEffect.length,
      denyRuleList: denyInEffect.map(redactDenyRule),
      // File inventory, scan-visible only, deliberately: nothing decides a
      // capability's state from `hooks`, `agents`, `skills` or `commands`
      // (a hook is credited from `hookRegistrations`, and `rules`, the one
      // inventory field a check does read, is the disk read after them).
      // Reading these off disk would buy no decision and would print the
      // names of files a user kept out of git into
      // `docs/harness/detect.json`, which is committed.
      hooks: under(files, '.claude/scripts/'),
      hookRegistrations: registrations,
      agents: under(files, '.claude/agents/', '.md'),
      skills: under(files, '.claude/skills/', '.md'),
      commands: under(files, '.claude/commands/', '.md'),
      // Read off disk, like every other field a check decides from.
      rules: claudeRuleFiles(root),
    },
    otherEditors: files.filter(f => OTHER_EDITOR_PREFIXES.some(p => f === p || f.startsWith(p + '/'))).sort(),
    architecture: existsAny(root, ['docs/ARCHITECTURE.md', 'ARCHITECTURE.md', 'docs/architecture.md']),
    // What the repository itself points at, and what documentation exists at
    // all — so P1.architecture can tell "there is none" from "I only know
    // three filenames". See gap-model.mjs.
    docPointers: docPointers(claudeMd ?? agentsMd, files),
    // Capped, so a repository with hundreds of documentation-shaped files
    // does not list every one in the committed report: the first 25 in
    // sorted order, and the total beside them.
    projectDocs: allDocs.slice(0, PROJECT_DOCS_LISTED),
    projectDocCount: allDocs.length,
    // The function session-brief.mjs resolves its own path with.
    handoff: findHandoff(root),
    bootstrap: existsAny(root, BOOTSTRAP_CANDIDATES),
    gitattributes: files.includes('.gitattributes'),
    remotes: remote.list,
    remotesError: remote.error,
  };
  // Phase 3 (intent and rules). Computed HERE, once, and carried on the
  // harness object — the same way `architecture`, `handoff` and `bootstrap`
  // are — so gap-model.mjs's three P3 checks stay pure functions of this
  // object and need no filesystem of their own. `rulesRegistryEvidence`
  // reads `claudeDir.denyRuleList` and `claudeDir.hookRegistrations` to
  // resolve `settings:` pointers, which is why it runs after the object
  // above is complete rather than inline in it.
  harness.intent = intentEvidence(root);
  harness.rulesRegistry = rulesRegistryEvidence(root, harness);
  harness.ruleShapedLines = ruleShapedLines(root, harness);
  harness.failures = failuresEvidence(root);
  harness.extensions = extensionsEvidence(root);
  harness.contract = contractWithInstalled(root);
  return harness;
}
