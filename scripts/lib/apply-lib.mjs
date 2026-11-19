// scripts/lib/apply-lib.mjs
//
// The only module in the kit that writes to a user's repository. Rules that
// make "never overwrite" structural rather than aspirational:
//   1. The write allowlist is enforced here, in code — never in settings.
//   2. Every proposal's target — allowlist AND filesystem containment — is
//      validated before any of them is written, so a bad proposal cannot
//      leave a half-applied repository.
//   3. A write-time failure (an I/O error pass 1 could not have predicted)
//      stops the batch but is recorded, never thrown away and never left
//      unrecorded — a partially applied repository that is accurately
//      described in its manifest is recoverable; one that is not, is not.
//   4. There is no --force. Not a flag, not an option, not a code path.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { defaultBranches, git, gitFailure } from './git-info.mjs';
import { classify, contentMatches, emptyManifest, MANIFEST_PATH, replaceFile, sha256 } from './manifest.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { addDenyRules, addHookEntry, buildMatcherEntry, hasEquivalentHook, SETTINGS_PATH } from './settings-merge.mjs';
import { readJsonFile, stripBom, UTF8_BOM } from './read-json.mjs';

/**
 * Paths the dirty-tree gate must not hold against the user: the tool's own
 * prior writes, per the manifest's own record of them — never re-derived
 * from the filesystem, which is exactly what a forged or stale record could
 * fool. `.claude/settings.json` counts only when the manifest actually
 * recorded a patch there; an untouched settings.json dirtied by something
 * else is not "ours" merely because it shares that path. The manifest file
 * itself is always ours: it is this tool's own bookkeeping, and a run that
 * updates it (new `installedAt`, a new file entry) is expected to leave it
 * modified if the user has ever committed it. So is `detect`'s report: its
 * `generatedAt` changes on every run, so a user who commits it would be
 * refused on every apply that followed a detect.
 * A corrupt manifest cannot be trusted to name what is ours, so nothing is
 * excused then and the gate is at its strictest; a missing one (a first
 * run) still excuses the fixed paths.
 */
function ownedByUs(manifestResult) {
  if (manifestResult.state === 'corrupt') return new Set();
  const owned = new Set([MANIFEST_PATH, DETECT_REPORT_PATH]);
  const manifest = manifestResult.manifest;
  for (const f of manifest?.files ?? []) owned.add(f.path);
  if ((manifest?.settingsPatches ?? []).length > 0) owned.add(SETTINGS_PATH);
  return owned;
}

/**
 * True only for changes to tracked files NOT already accounted for by
 * `ignorePaths` — new, untracked files are not this tool's problem either
 * way. Without `ignorePaths`, this tool's own first `apply --yes` dirties
 * any tracked `.claude/settings.json` it patches, and a plain second run
 * would be refused with no recourse but `--allow-dirty`, which waives the
 * gate for every other uncommitted change too. The gate still refuses for
 * anything that is not ours.
 *
 * `-z` for the reason `scan.mjs`'s `gitPaths` uses it: git's quoted output
 * escapes non-ASCII bytes in octal, and `.claude/caf\303\251.md` would
 * compare unequal to the owned entry for the same file, so this tool's own
 * prior write would look like the user's uncommitted work.
 *
 * Porcelain v1 in `-z` mode: each record is `XY<space><path>`, NUL-
 * terminated, and a rename or copy emits the NEW path in its own record
 * followed immediately by the ORIGINAL path as a separate record — there is
 * no ` -> ` form here. The status belongs to the pair, and the path that
 * matters is the new one, so the original-path record is consumed and never
 * tested.
 *
 * Returns `{ dirty, error }`. A failed `git status` is an error, never
 * "clean": read as clean it would waive the gate on exactly the
 * repositories where git cannot be trusted to answer. An error is the
 * caller's to refuse on.
 */
function trackedChanges(root, ignorePaths) {
  let out;
  try {
    out = git(root, ['status', '--porcelain', '-z', '--untracked-files=no']);
  } catch (err) {
    return { dirty: false, error: gitFailure(err, 'report the status of the tree') };
  }
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Rename/copy: skip the original-path record that follows this one.
    if (status.includes('R') || status.includes('C')) i += 1;
    if (!ignorePaths.has(path.split('\\').join('/'))) return { dirty: true, error: null };
  }
  return { dirty: false, error: null };
}

/**
 * The two refusals that protect `git diff` as the record of what this tool
 * did — the default branch and a dirty tree — as the sentences a write
 * prints before exiting 3, or, on a dry run, prints as notes after the
 * diffs. A dry run writes nothing, so there is nothing to refuse. Every
 * command that writes into the repository asks this one
 * function, so the commands cannot disagree. `git` is `gitInfo(root)`,
 * `manifestResult` is `readManifestResult(root)`, and `verb` names the
 * command in the refusal ("apply", "land").
 *
 * Three cases the gates must not be bypassed by: a repository with no
 * commits (an unborn `main` is `main`: `gitInfo` reads the symbolic ref,
 * not a commit); a default branch not named `main` or `master`
 * (`defaultBranches` adds `init.defaultBranch` and `origin/HEAD`); and a
 * git that cannot answer at all (not installed, "dubious ownership"), which
 * is refused unless both waivers are given, because neither gate could run.
 */
export function writeGateRefusals({ root, git, manifestResult, allowDefaultBranch, allowDirty, verb }) {
  if (git.error) {
    return allowDefaultBranch && allowDirty ? [] : [
      `git could not report the state of ${root} (${git.error}), so neither the default-branch gate nor the ` +
      `dirty-tree gate can run. Re-run with --allow-default-branch --allow-dirty to proceed without them.`,
    ];
  }
  if (!git.isRepo) return [];
  const refusals = [];
  if (!allowDefaultBranch && defaultBranches(root).includes(git.branch)) {
    refusals.push(
      `refusing to ${verb} on the default branch "${git.branch}". A user must be able to \`git diff\` exactly what ` +
      `this tool did — switch to a feature branch, or re-run with --allow-default-branch if this is intentional.`,
    );
  }
  if (!allowDirty) {
    const { dirty, error } = trackedChanges(root, ownedByUs(manifestResult));
    if (error) {
      refusals.push(`git could not report whether the tree is clean (${error}), so the dirty-tree gate cannot run. Re-run with --allow-dirty to proceed without it.`);
    } else if (dirty) {
      refusals.push(
        `refusing to ${verb} with uncommitted changes to tracked files. Commit or stash first so you can ` +
        `\`git diff\` what this tool did, or re-run with --allow-dirty.`,
      );
    }
  }
  return refusals;
}

// The tree entry modes of a regular file, executable or not. A symbolic
// link (120000) is a blob too, but its content is a path, not the file.
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/**
 * The file `rel` as the commit HEAD names holds it, read up to `maxBytes`:
 * `{ text }`, `{ absent: true }` when that commit has no such file, `{
 * tooLarge: true }` when it holds more than `maxBytes` bytes, or `{ unknown
 * }`, a sentence saying truly why it could not be read: not a git
 * repository, a branch with no commit yet, something other than a regular
 * file at `rel`, git missing, failing, stopped or not answering in time.
 *
 * The working tree and the index are not consulted, so a removal not yet
 * committed does not hide what the commit holds; nor is anything resolved
 * against the working tree's file names, since the file is found with
 * `ls-tree` after `--` and read by its object id. Every call runs git with
 * `--no-replace-objects`, so no `refs/replace/` object the repository holds
 * changes what the commit is read as; with its arguments as an array, never
 * through a shell; under a timeout; and in `commitReadEnv` (git-info.mjs's
 * `git`, as every kit git call does). The bound is on the bytes git gives,
 * as the gate hook bounds the file's size, not on the text they decode to.
 */
export function committedText(root, rel, maxBytes) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  } catch (err) {
    // `--verify --quiet` exits 1 and says nothing when HEAD names no commit.
    const silent = err?.status === 1 && String(err?.stderr ?? '').trim() === '';
    return { unknown: silent ? 'the branch has no commit yet' : gitFailure(err, 'read HEAD') };
  }
  let listing;
  try {
    listing = git(root, ['ls-tree', '-z', 'HEAD', '--', rel]);
  } catch (err) {
    return { unknown: gitFailure(err, 'list the committed file') };
  }
  if (listing === '') return { absent: true };
  const entry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(listing);
  if (entry === null || entry[2] !== 'blob' || !REGULAR_FILE_MODES.has(entry[1])) {
    return { unknown: `the commit holds something other than a regular file at ${rel}` };
  }
  let bytes;
  try {
    // One byte past the bound is read, so a file of exactly `maxBytes` is
    // told from a larger one.
    bytes = git(root, ['cat-file', 'blob', entry[3]], { maxBuffer: maxBytes + 1, encoding: 'buffer' });
  } catch (err) {
    if (err?.code === 'ENOBUFS') return { tooLarge: true };
    return { unknown: gitFailure(err, 'read the committed file') };
  }
  return bytes.length > maxBytes ? { tooLarge: true } : { text: bytes.toString('utf8') };
}

// A hand-rolled O(n·m) LCS diff is fine for the kit's own small template and
// script files. It is not fine for an arbitrary file a future proposal might
// target: 20k lines is already gigabytes of DP table, 40k OOMs Node. Above
// this many lines on either side, print a summary instead of a diff.
const DIFF_LINE_BAILOUT = 3000;

// Exact paths and path prefixes the kit is ever allowed to write. Anything
// else — however it got proposed — is refused before a single byte is
// written. This list, not a permission rule in settings.json, is what keeps
// kh-harness from ever touching a user's own files: settings-based
// containment would appear to work (writes match through `Edit`, not
// `Write(path)`) and silently would not.
// `docs/INTENT.md` (Phase 3) joins `docs/ARCHITECTURE.md` here for the same
// reason: both are written by the SKILL at a gate, not by any generator, and
// the allowlist is the one statement of every path this kit may ever write.
// Never CLAUDE.md: the file most likely to hold decisions that cannot be
// re-derived from source. No generator proposes it — P1.instructions is a
// prompt, and the skill drafts docs/harness/CLAUDE.proposed.md itself for
// the user to merge — so the allowlist refuses it outright.
const ALLOWED_EXACT = new Set(['HANDOFF.md', 'docs/ARCHITECTURE.md', 'docs/INTENT.md']);
const ALLOWED_PREFIXES = ['docs/harness/', '.claude/', 'scripts/'];

/** Throws on any path outside the allowlist. Never consulted anywhere but here. */
export function assertAllowed(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`not allowed: empty or non-string path`);
  }

  const normalized = relPath.split('\\').join('/');

  // Absolute paths (POSIX or Windows-drive-letter) are never relative to the
  // target repository, so they are never allowed regardless of what they say.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`not allowed: absolute path: ${relPath}`);
  }

  // Path traversal: any ".." segment could escape the repository root.
  if (normalized.split('/').includes('..')) {
    throw new Error(`not allowed: path traversal: ${relPath}`);
  }

  // .git is explicitly off-limits even though nothing in ALLOWED_PREFIXES
  // would ever match it — a repository's own history is never a write target.
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error(`not allowed: .git is off-limits: ${relPath}`);
  }

  if (ALLOWED_EXACT.has(normalized) || ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return;
  }

  throw new Error(`not allowed: "${relPath}" is outside the write allowlist`);
}

/**
 * The allowlist question for a directory, asked by uninstall-lib.mjs's
 * directory cleanup. It is not a second list: it reads the `ALLOWED_EXACT`
 * and `ALLOWED_PREFIXES` constants `assertAllowed` reads, so what this tool
 * may remove cannot diverge from what it may write. A directory is allowed
 * exactly when it:
 *   - equals one of `ALLOWED_PREFIXES` with its trailing slash stripped
 *     (`.claude`, `scripts`, `docs/harness`), the directories the
 *     generators write directly under; or
 *   - sits under one of those prefixes (`.claude/scripts`, `.claude/rules`);
 *     or
 *   - is the parent directory of one of `ALLOWED_EXACT`'s file paths
 *     (`docs`, the parent of `docs/ARCHITECTURE.md`): a directory no
 *     prefix names, but one a write can bring into existence.
 *
 * It does not repeat `assertAllowed`'s absolute-path, `..` and `.git`
 * checks: a directory path reaching it has cleared those in
 * uninstall-lib.mjs's own guard, and `assertContained` follows.
 */
export function isAllowedDirectory(relDir) {
  const normalized = relDir.split('\\').join('/');
  if (ALLOWED_PREFIXES.some(p => p === `${normalized}/`)) return true;
  if (ALLOWED_PREFIXES.some(p => normalized.startsWith(p))) return true;
  for (const f of ALLOWED_EXACT) {
    const parent = dirname(f);
    if (parent !== '.' && parent === normalized) return true;
  }
  return false;
}

/**
 * The allowlist is a string check on the *proposed* relative path. This is
 * the filesystem check: where does that path actually resolve on disk, right
 * now? A pre-existing symlink or junction anywhere along the chain — down to
 * and including the target itself, not just its parent — can route a write
 * outside the repository even though the proposed path string looks fine.
 *
 * The walk starts at the exact target, not dirname(target): a dangling
 * symlink sitting AT the target (e.g. HANDOFF.md itself is a broken symlink)
 * redirects a create-on-write there, and checking only the parent directory
 * would miss it entirely, since the parent (the repo root) is always fine.
 *
 * Exported because uninstall-lib.mjs needs exactly this check before every
 * rmSync. A delete routed outside the repository by a junction is at least
 * as bad as a write routed there, and the allowlist alone cannot see it.
 */
export function assertContained(root, relPath) {
  const abs = join(root, relPath);

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new Error(`not allowed: could not resolve the repository root while checking "${relPath}"`);
  }

  let cur = abs;
  for (;;) {
    let entry;
    try {
      entry = lstatSync(cur); // does not follow a symlink/junction at cur itself
    } catch {
      entry = null;
    }
    if (entry) break;
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root without finding anything
    cur = parent;
  }

  let real;
  try {
    real = realpathSync(cur); // fully resolves any symlink/junction chain
  } catch {
    // Most commonly a dangling symlink: it exists (lstat succeeded above) but
    // cannot be resolved to a real, existing location. Refuse rather than
    // assume it is safe.
    throw new Error(`not allowed: "${relPath}" cannot be verified to stay inside the repository (broken symlink?)`);
  }

  const rel = relative(realRoot, real);
  const escapes = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
  if (escapes) {
    throw new Error(`not allowed: "${relPath}" escapes the repository root via a symlink or junction`);
  }
}

function splitLines(content) {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

/**
 * Line-based diff via a longest-common-subsequence table. Not the fastest
 * algorithm available, but this project has zero npm dependencies and these
 * are hand-authored template files, not generated multi-megabyte sources.
 * See DIFF_LINE_BAILOUT for the point past which this stops being true.
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', line: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: b[j] }); j++; }
  return ops;
}

function unifiedDiff(before, after, label) {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > DIFF_LINE_BAILOUT || b.length > DIFF_LINE_BAILOUT) {
    return `--- a/${label}\n+++ b/${label}\n` +
      `(diff suppressed: ${a.length} vs ${b.length} lines exceeds the ${DIFF_LINE_BAILOUT}-line preview limit)`;
  }

  const ops = diffLines(a, b);
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const op of ops) {
    if (op.type === 'ctx') lines.push(` ${op.line}`);
    else if (op.type === 'add') lines.push(`+${op.line}`);
    else lines.push(`-${op.line}`);
  }
  return lines.join('\n');
}

/**
 * True for a `hooks` block the merge can safely traverse —
 * `{ "<Event>": [ { "matcher"?, "hooks"?: [ … ] } ] }`, the containers Claude
 * Code documents; the types inside them are not judged — or for an absent
 * one. Checked at the read, like `permissions`: `{"hooks":{"Stop":{}}}`
 * that passed it would make `addHookEntry` throw on `.push`, and `--yes`
 * fail after a dry run that had shown a clean diff. Exported for its test
 * only.
 */
export function isWellFormedHooks(hooks) {
  if (hooks === undefined) return true;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return Object.values(hooks).every(matchers => Array.isArray(matchers) && matchers.every(m =>
    m !== null && typeof m === 'object' && !Array.isArray(m) && (m.hooks === undefined || Array.isArray(m.hooks)),
  ));
}

/**
 * Reads `.claude/settings.json`. Distinguishes "absent" (fine — treated as
 * `{}`) from "present but unreadable as a settings object" (parse error, or
 * valid JSON that is not a plain object — an array, a string, null, ...).
 * The latter must never be silently replaced with `{}`: that would destroy
 * the user's file rather than merge into it.
 */
function readSettingsResult(root) {
  const read = readJsonFile(join(root, SETTINGS_PATH));
  if (read.state === 'absent') return { ok: true, settings: {}, raw: null };
  if (read.state === 'unreadable') return { ok: false, reason: read.reason };

  const parsed = read.value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'is not a JSON object' };
  }

  // `permissions` and `permissions.deny`, when present, must be shapes
  // addDenyRules can safely mutate — a plain object, and an array,
  // respectively. Validated HERE, once, rather than inside addDenyRules:
  // every consumer of this result then sees one validated shape, so
  // `{"permissions":"nope"}` or `{"permissions":{"deny":3}}` is refused
  // exactly like unparseable JSON, never passed through to crash a
  // `.push(...)` or a `new Set(...)` deep inside the merge.
  const permissions = parsed.permissions;
  if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))) {
    return { ok: false, reason: 'has a `permissions` that is not an object' };
  }
  const deny = permissions?.deny;
  if (deny !== undefined && !Array.isArray(deny)) {
    return { ok: false, reason: 'has a `permissions.deny` that is not an array' };
  }
  // Same discipline for `hooks` — see isWellFormedHooks.
  if (!isWellFormedHooks(parsed.hooks)) {
    return { ok: false, reason: 'has a `hooks` block that is not the shape Claude Code documents' };
  }

  return { ok: true, settings: parsed, raw: read.text };
}

/**
 * Why `.claude/settings.json` cannot take a patch, as a predicate phrase
 * ("is not valid JSON"), or null when it can — an absent file can, since it
 * is created. A run that would patch it must write nothing at all while this
 * is non-null: the hook scripts a patch registers are inert without it.
 */
export function unusableSettingsReason(root) {
  const result = readSettingsResult(root);
  return result.ok ? null : result.reason;
}

/**
 * The trailing newline a settings write ends with: the file's own. `raw` is
 * the file's original text, or null for a file being created, which gets
 * the conventional newline. A write that always appended one would add a
 * one-line diff to a file that had none. Narrow on purpose: this matches
 * one byte, and `serializeSettings` the indentation; the rest of a reformat
 * is disclosed, not prevented.
 */
function matchingNewline(raw) {
  return raw != null && !raw.endsWith('\n') ? '' : '\n';
}

/**
 * True when this JSON file is already in exactly the form this tool writes
 * (`serializeSettings` of its own content gives back its own text). A patch
 * then cannot have reformatted anything else, and the reformat disclosure
 * must not be printed. The one predicate both writers of the file ask,
 * built on the serialiser both call.
 *
 * `raw == null` means the file did not exist, so there was nothing to
 * reformat; an unparseable file never reaches a settings write at all. Both
 * answer `true`.
 */
export function isCanonicalJson(raw) {
  if (raw == null) return true;
  try {
    return raw === serializeSettings(JSON.parse(stripBom(raw)), raw);
  } catch {
    return true;
  }
}

/**
 * The text a settings write puts on disk: `value`, serialised in `raw`'s
 * own leading BOM, indentation and trailing-newline form (`raw` null for a
 * file being created). The one serialiser both writers of the file use, and
 * the one `isCanonicalJson` compares against.
 */
export function serializeSettings(value, raw) {
  const bom = raw?.startsWith(UTF8_BOM) ? UTF8_BOM : '';
  return bom + JSON.stringify(value, null, detectIndent(raw)) + matchingNewline(raw);
}

/**
 * The indentation `raw` uses — a tab, or the run of spaces on its first
 * indented line — so a settings write keeps it, and a four-space file does
 * not come back re-indented throughout. Two spaces for a compact file, and for a file
 * being created (`raw` null). Exported for its test; writers go through
 * `serializeSettings`.
 */
export function detectIndent(raw) {
  if (raw == null) return '  ';
  const m = /^([ \t]+)\S/m.exec(raw);
  if (!m) return '  ';
  return m[1].startsWith('\t') ? '\t' : m[1];
}

/**
 * The one sentence that discloses a settings.json reformat. apply.mjs and
 * uninstall.mjs both parse and re-serialise the file, applying a patch and
 * reverting one, and both print this, so the two cannot word it
 * differently; `verb` is all that differs ("applying the patch above",
 * "reverting the patch(es) above"). Both writers keep the file's
 * indentation and trailing newline, so what is disclosed is key order and
 * inline spacing.
 */
export function settingsReformattedNote(verb) {
  return `note       .claude/settings.json was re-serialised while ${verb} — its content is ` +
    `unchanged beyond what was listed, and its indentation and the trailing newline are kept, but ` +
    `key order and inline spacing are normalised (this tool parses and re-serialises the file; it ` +
    `does not preserve every byte of the original formatting).`;
}

/** What either settings preview says instead of a diff when the file cannot take a patch. */
function unusableSettingsPreview(reason) {
  return `--- a/${SETTINGS_PATH}\n+++ b/${SETTINGS_PATH}\n` +
    `(${SETTINGS_PATH} could not be parsed as a JSON object: it ${reason}. --yes writes nothing at all — ` +
    `not this patch, and not the files it would activate — until that is fixed)`;
}

/**
 * Preview of a settings-hook proposal against `settings`: the added entry,
 * and nothing else.
 *
 * `.claude/settings.json` is the most credential-dense file this tool
 * touches, and a dry run is the default, so whatever this emits is printed
 * to a terminal without anyone asking for it. `addHookEntry` only ever
 * appends one matcher entry to `hooks[event]`, so the entire change is that
 * one entry, and nothing outside it is read into the preview: a full diff
 * would print the owner's `env` block and every unrelated hook command.
 *
 * The entry shown is built by `buildMatcherEntry`, the function
 * `addHookEntry` pushes with, so the preview cannot differ from the write.
 */
function settingsHookPreview(settings, proposal) {
  const container = `hooks.${proposal.event}`;
  const siblings = Array.isArray(settings?.hooks?.[proposal.event]) ? settings.hooks[proposal.event].length : 0;
  const added = JSON.stringify(buildMatcherEntry(proposal.entry, proposal.matcher), null, 2);

  const lines = [`--- a/${SETTINGS_PATH}`, `+++ b/${SETTINGS_PATH}`, `@@ ${container} @@`];
  for (const line of splitLines(added)) lines.push(`+${line}`);
  if (siblings > 0) {
    lines.push(`(appended after ${siblings} existing ${container} entr${siblings === 1 ? 'y' : 'ies'}, which are left unchanged and not shown)`);
  }
  lines.push(`(nothing else in ${SETTINGS_PATH} is changed, or shown — it is yours, and it may hold credentials)`);
  return lines.join('\n');
}

/**
 * Preview of a settings-deny proposal against `settings`: the rules that
 * would be added, `added` as `addDenyRules` computes them, and nothing
 * else. `permissions.deny` can hold the owner's own rules, and a
 * `Bash(curl ... TOKEN ...)` pattern is as valid a deny rule as any other,
 * so diffing the whole array would leak as diffing the whole file would.
 */
function settingsDenyPreview(settings, added) {
  const existing = Array.isArray(settings?.permissions?.deny) ? settings.permissions.deny.length : 0;
  const lines = [`--- a/${SETTINGS_PATH}`, `+++ b/${SETTINGS_PATH}`, `@@ permissions.deny @@`];
  if (added.length === 0) {
    lines.push(`(every proposed rule is already present — nothing would be added)`);
  } else {
    for (const rule of added) lines.push(`+${JSON.stringify(rule)}`);
    if (existing > 0) {
      lines.push(`(appended after ${existing} existing permissions.deny entr${existing === 1 ? 'y' : 'ies'}, which are left unchanged and not shown)`);
    }
  }
  lines.push(`(nothing else in ${SETTINGS_PATH} is changed, or shown — it is yours, and it may hold credentials)`);
  return lines.join('\n');
}

/** Unified-style diff of a file proposal against what is on disk today (or
 * nothing). */
function fileDiff(root, proposal) {
  const targetPath = proposal.path;
  const target = join(root, targetPath);
  // A new file that is a verbatim copy of a shipped asset (`assetSource`,
  // set only by the kit's own generators and pinned against the asset on
  // disk in propose.test.mjs) is summarised in one line: a first dry run
  // would otherwise print every hook script in full. An update of an
  // installed asset still shows the real diff, since what changes in a file
  // on disk is what the reader needs to see.
  if (proposal.assetSource && !existsSync(target)) {
    const lines = splitLines(proposal.contents).length;
    return `+${lines} lines — a verbatim copy of assets/${proposal.assetSource} plus the kit's stamp line at the top; nothing of yours is changed`;
  }
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  return unifiedDiff(before, proposal.contents, targetPath);
}

/**
 * A function that previews one proposal of a run at a time, in the order
 * `apply` will act on them. The settings file is read once, and each
 * settings preview is made against what the previews before it would leave,
 * as the write is: so the second deny preview of a run counts, and does not
 * offer again, the rules the first adds.
 */
export function diffRenderer(root) {
  let staged = null;
  return proposal => {
    if (proposal.kind === 'file') return fileDiff(root, proposal);
    staged ??= readSettingsResult(root);
    if (!staged.ok) return unusableSettingsPreview(staged.reason);
    if (proposal.kind === 'settings-hook') {
      const preview = settingsHookPreview(staged.settings, proposal);
      staged.settings = addHookEntry(staged.settings, proposal.event, proposal.entry, proposal.matcher).settings;
      return preview;
    }
    const { settings, added } = addDenyRules(staged.settings, proposal.globs);
    const preview = settingsDenyPreview(staged.settings, added);
    staged.settings = settings;
    return preview;
  };
}

/** The preview of one proposal on its own, against what is on disk today. */
export function renderDiff(root, proposal) {
  return diffRenderer(root)(proposal);
}

/**
 * `mode`, when given, is applied with an explicit `chmod` call AFTER the
 * write — not merely passed as `writeFileSync`'s own `mode` option, which
 * Node only honours when the file is actually CREATED (the open flag's
 * mode is ignored on an existing file). A proposal like P1.bootstrap's
 * `scripts/bootstrap.sh` (mode `0o755` — it has a shebang and is meant to
 * be executed directly) must end up executable whether this is the first
 * write or a later one re-writing changed contents.
 *
 * `chmod` is injected (defaulting to the real `chmodSync`) for the same
 * reason `verify.mjs`'s `run` is injectable: real POSIX mode bits are not
 * observable on every platform this project is developed on (Windows'
 * `chmodSync` has no execute-bit concept `stat().mode` can report), but
 * the call this function makes is the same production line
 * regardless of OS. Injecting `chmod` lets a test pin that line directly,
 * on every platform, rather than asserting an effect one platform cannot
 * produce.
 */
function writeFileDeep(absPath, contents, relPath, mode, chmod) {
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents, 'utf8');
    if (mode != null) chmod(absPath, mode);
  } catch (err) {
    const wrapped = new Error(`failed to write ${relPath}: ${err.message}`);
    wrapped.path = relPath;
    throw wrapped;
  }
}

function upsertFileEntry(files, entry) {
  const idx = files.findIndex(f => f.path === entry.path);
  if (idx === -1) files.push(entry);
  else files[idx] = entry;
}

/**
 * Records, in `nextManifest.dirsCreated`, each directory this write is
 * about to bring into existence, so uninstall can remove it once it is
 * empty. That has to be recorded at the moment of creation: "is this
 * directory empty" cannot answer "did we create it", since a user's own
 * empty directory of the same name looks the same afterwards. A directory
 * that already exists is never recorded.
 *
 * Called before the write's own `mkdirSync(..., { recursive: true })`, so
 * each ancestor is checked against the filesystem as it stood before the
 * write. `nextManifest` is mutated in place and de-duplicated, so it is
 * safe to call once per write when an earlier write in the batch created a
 * shared ancestor.
 */
function recordCreatedDirs(root, nextManifest, relPath) {
  const dir = dirname(relPath.split('\\').join('/'));
  if (dir === '.' || dir === '/') return;
  const created = new Set(nextManifest.dirsCreated ?? []);
  let cum = '';
  for (const seg of dir.split('/')) {
    cum = cum ? `${cum}/${seg}` : seg;
    if (!existsSync(join(root, cum))) created.add(cum);
  }
  nextManifest.dirsCreated = [...created];
}

function applyFileProposal({ root, proposal, nextManifest, written, skipped, chmod }) {
  const targetPath = proposal.path;

  const cls = classify(root, nextManifest, targetPath);
  const abs = join(root, targetPath);

  if (cls === 'ours-unmodified') {
    const existingEntry = nextManifest.files.find(f => f.path === targetPath);
    const newHash = sha256(proposal.contents);
    if (existingEntry && existingEntry.sha256 === newHash) {
      // Identical content already in place: nothing to write, but a library
      // caller must be able to tell "nothing needed doing" from "nothing
      // happened" — report it rather than staying silent.
      skipped.push({ path: targetPath, why: 'unchanged', checkId: proposal.checkId });
      return;
    }

    recordCreatedDirs(root, nextManifest, targetPath);
    writeFileDeep(abs, proposal.contents, targetPath, proposal.mode, chmod);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: newHash, step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId, mode: proposal.mode });
    return;
  }

  if (cls === 'theirs' && !existsSync(abs)) {
    recordCreatedDirs(root, nextManifest, targetPath);
    writeFileDeep(abs, proposal.contents, targetPath, proposal.mode, chmod);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: sha256(proposal.contents), step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId, mode: proposal.mode });
    return;
  }

  // Either `theirs` and already present, or `ours-modified` — a run that
  // declines to overwrite must say so, not quietly report success.
  skipped.push({ path: targetPath, why: cls, checkId: proposal.checkId });
}

/**
 * Why a settings patch that activates a script must not be applied, or null
 * when it may: each file in `requiresFiles`, `{ path, sha256 }`, must be on
 * disk holding the bytes this kit writes there (line endings aside). A hook
 * registered beside a missing module dies with `ERR_MODULE_NOT_FOUND` on
 * every event, and one registered beside a module another kit version wrote
 * can die at import for a name that module lacks.
 *
 * Read from the files themselves, after the write phase, never from the
 * batch's plan or the manifest: propose.mjs never proposes again a recorded
 * file the owner deleted or edited, so the plan can lack a file the hook
 * loads, and the manifest records only what an earlier run believed it wrote.
 */
function unmetDependencies(root, proposal) {
  const missing = [];
  const stale = [];
  for (const { path, sha256: expected } of proposal.requiresFiles ?? []) {
    let bytes;
    try {
      bytes = readFileSync(join(root, path));
    } catch {
      missing.push(path);
      continue;
    }
    if (!contentMatches(bytes, expected)) stale.push(path);
  }
  if (missing.length) return `missing-dependency: ${missing.join(', ')}`;
  return stale.length ? `dependency-not-this-kit-version: ${stale.join(', ')}` : null;
}

/**
 * `.claude/settings.json` as one run patches it: read once, patched in
 * memory by each settings proposal in turn, and written once at the end
 * (`writeSettingsBatch`). `records` are the manifest's patch records for
 * what has been staged, `patched` what the caller is told of each.
 */
function openSettingsBatch(root) {
  const read = readSettingsResult(root);
  return { read, settings: read.ok ? read.settings : null, records: [], patched: [] };
}

function stageSettingsHook({ root, proposal, batch, skipped }) {
  const unmet = unmetDependencies(root, proposal);
  if (unmet !== null) {
    skipped.push({ path: SETTINGS_PATH, why: unmet, checkId: proposal.checkId });
    return;
  }
  if (!batch.read.ok) {
    // An unparseable settings.json (trailing commas, comments, a JSON array
    // instead of an object) must never be replaced with `{}`: that destroys
    // whatever the owner had. Nothing is written; it is reported.
    skipped.push({ path: SETTINGS_PATH, why: 'unparseable', checkId: proposal.checkId });
    return;
  }
  if (hasEquivalentHook(batch.settings, proposal.event, proposal.entry, proposal.matcher)) {
    skipped.push({ path: SETTINGS_PATH, why: 'unchanged', checkId: proposal.checkId });
    return;
  }

  const { settings, patch } = addHookEntry(batch.settings, proposal.event, proposal.entry, proposal.matcher);
  batch.settings = settings;
  batch.records.push({
    event: proposal.event,
    container: patch.container,
    entrySha256: patch.entrySha256,
    step: proposal.step,
    checkId: proposal.checkId,
    appliedAt: new Date().toISOString(),
  });
  batch.patched.push({ event: proposal.event, step: proposal.step, checkId: proposal.checkId });
}

function stageSettingsDeny({ proposal, batch, skipped }) {
  if (!batch.read.ok) {
    skipped.push({ path: SETTINGS_PATH, why: 'unparseable', checkId: proposal.checkId });
    return;
  }

  const { settings, patch } = addDenyRules(batch.settings, proposal.globs);
  // `addDenyRules` returns no patch when every proposed rule is already
  // present. A record of an empty change would have uninstall revert rules
  // that were never the kit's, so only a real patch is recorded.
  if (!patch) {
    skipped.push({ path: SETTINGS_PATH, why: 'unchanged', checkId: proposal.checkId });
    return;
  }

  batch.settings = settings;
  batch.records.push({
    event: 'permissions.deny',
    container: patch.container,
    entrySha256: patch.entrySha256,
    rules: patch.rules,
    step: proposal.step,
    checkId: proposal.checkId,
    appliedAt: new Date().toISOString(),
  });
  batch.patched.push({ event: 'permissions.deny', step: proposal.step, checkId: proposal.checkId });
}

/** What makes two patch records the same patch. */
const patchKey = patch => `${patch.container}\n${patch.entrySha256}`;

/**
 * Writes what the batch staged, in one whole-file replacement, so the file
 * on disk is the owner's old one or the complete new one. The manifest is
 * written first (`persistManifest`), holding the staged patch records and
 * every file written so far: a run killed before the settings file is
 * replaced leaves records of entries that are not there, which `uninstall`
 * drops and the next `apply` writes; one killed after it leaves the entries
 * recorded. Either way no entry is in the file without a record. A record
 * staged again replaces the one already held for the same patch, whose
 * entry is no longer in the file or it would not have been staged.
 *
 * A write that fails is reported in `failed`, and the records are taken
 * back out of `nextManifest`, which the caller writes next.
 *
 * `settingsCreated` is set the first time a run finds the file absent and
 * has written it, and never reset: once the file was the kit's to create,
 * it stays the kit's to remove when empty. It is recorded only after the
 * write, so a file the kit did not create is never taken for one it did.
 */
function writeSettingsBatch({ root, batch, nextManifest, patched, failed, replaceSettings, persistManifest }) {
  if (batch === null || batch.records.length === 0) return;
  // Before the writes, whose own mkdir would hide which directories are new.
  recordCreatedDirs(root, nextManifest, SETTINGS_PATH);
  const held = nextManifest.settingsPatches;
  const staged = new Set(batch.records.map(patchKey));
  nextManifest.settingsPatches = [...held.filter(patch => !staged.has(patchKey(patch))), ...batch.records];
  try {
    persistManifest(nextManifest);
  } catch (err) {
    nextManifest.settingsPatches = held;
    failed.push({ path: MANIFEST_PATH, error: `failed to record the settings patches in ${MANIFEST_PATH}, so ${SETTINGS_PATH} was not written: ${err?.message ?? String(err)}` });
    return;
  }
  try {
    replaceSettings(join(root, SETTINGS_PATH), serializeSettings(batch.settings, batch.read.raw));
  } catch (err) {
    nextManifest.settingsPatches = held;
    failed.push({ path: SETTINGS_PATH, error: `failed to write ${SETTINGS_PATH}: ${err?.message ?? String(err)}` });
    return;
  }
  if (batch.read.raw === null) nextManifest.settingsCreated = true;
  patched.push(...batch.patched);
}

/**
 * Applies proposals additively: writes only what classify() says is safe to
 * write, never mutates the manifest it was given, and validates every
 * proposal's target — allowlist and filesystem containment — before writing
 * any of them, so a bad proposal cannot leave a half-applied repository.
 *
 * Never throws on an I/O failure encountered while applying. Such a failure
 * stops the batch (nothing after it is attempted) but is recorded in
 * `failed` and returned normally, with the manifest reflecting exactly what
 * was written before the failure — so the caller can always write that
 * manifest and know it describes reality.
 *
 * `chmod` defaults to the real `chmodSync` and is never overridden by any
 * production caller (apply.mjs) — it exists so a test can inject a stub and
 * assert the call itself, platform-independently, rather than its OS-level
 * effect (see `writeFileDeep`'s own comment on why that effect is not
 * observable on every platform this project is developed on).
 * `replaceSettings` is `replaceFile` in production, and overridable for the
 * same reason: so a test can make the one settings write fail partway.
 *
 * `persistManifest` writes the manifest it is given. A caller whose
 * proposals patch the settings file passes it, since the patch records must
 * be on disk before the settings file is replaced (`writeSettingsBatch`);
 * it is not called for a batch with no settings patch. The caller still
 * writes the returned manifest afterwards.
 */
export function applyProposals({ root, proposals, manifest, kitVersion, chmod = chmodSync, replaceSettings = replaceFile, persistManifest = () => {} }) {
  // Pass 1: validate. No write happens until every proposal in the batch has
  // cleared both the allowlist and the containment check.
  //
  // KNOWN GAP, deliberately not closed here. `assertContained` is a
  // filesystem check, and pass 2 writes without re-running it: between the
  // two passes an adversary with write access to the repository could
  // replace a validated directory with a junction, and the write would
  // follow it out. Closing that needs an open-then-verify-by-handle write
  // rather than a path write, which Node's synchronous fs makes awkward and
  // which would buy nothing against an attacker who already has write access
  // to the tree. It is recorded because it is the same shape as I1 — a
  // decision made once and then trusted — and because the next person to
  // touch this loop should know the re-check is missing on purpose.
  // uninstall-lib.mjs does re-check at delete time; the cost there is one
  // realpathSync per entry, and deleting is not recoverable.
  for (const proposal of proposals) {
    if (proposal.kind === 'file') {
      assertAllowed(proposal.path);
      assertContained(root, proposal.path);
    } else if (proposal.kind === 'settings-hook' || proposal.kind === 'settings-deny') {
      assertAllowed(SETTINGS_PATH);
      assertContained(root, SETTINGS_PATH);
    } else {
      throw new Error(`apply: unknown proposal kind: ${proposal.kind}`);
    }
  }

  const written = [];
  const patched = [];
  const skipped = [];
  const failed = [];

  const nextManifest = structuredClone(manifest ?? emptyManifest(kitVersion));
  nextManifest.files ??= [];
  nextManifest.settingsPatches ??= [];

  // Pass 2: apply. Every path in this batch already cleared validation; what
  // remains is what validation cannot predict — actual I/O. Files are
  // written as they come; settings patches are staged in memory and written
  // once, after the loop, whether it ended or was stopped by a failure.
  let batch = null;
  for (const proposal of proposals) {
    try {
      if (proposal.kind === 'file') {
        applyFileProposal({ root, proposal, nextManifest, written, skipped, chmod });
      } else {
        batch ??= openSettingsBatch(root);
        if (proposal.kind === 'settings-hook') stageSettingsHook({ root, proposal, batch, skipped });
        else stageSettingsDeny({ proposal, batch, skipped });
      }
    } catch (err) {
      failed.push({ path: err?.path ?? proposal.path ?? SETTINGS_PATH, error: err?.message ?? String(err) });
      break;
    }
  }
  writeSettingsBatch({ root, batch, nextManifest, patched, failed, replaceSettings, persistManifest });

  // The version that last wrote, not the one that first created the
  // manifest. A run that changed nothing leaves it alone. It says nothing
  // of a file that run did not write: `P0.kitskew` reads each file's stamp.
  if (written.length || patched.length) nextManifest.kitVersion = kitVersion;

  return { written, patched, skipped, failed, manifest: nextManifest };
}

// `ALLOWED_PREFIXES` is exported for exactly one purpose: a test proving
// `assertAllowed` and `isAllowedDirectory` read the SAME list, not two that
// happen to agree today — see apply-lib.test.mjs. No production caller
// should import it to re-derive its own allowlist logic;
// `assertAllowed`/`isAllowedDirectory` are the two sanctioned readers.
export { SETTINGS_PATH, ALLOWED_PREFIXES };
