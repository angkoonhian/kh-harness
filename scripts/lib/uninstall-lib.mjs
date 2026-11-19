// scripts/lib/uninstall-lib.mjs
//
// The delete side of apply-lib.mjs. It must mirror apply's *defences*, not
// only its bookkeeping: deleting a file is at least as destructive as
// writing one, so every path reaches rmSync only after clearing the same two
// gates apply clears before writeFileSync — the write allowlist and
// filesystem containment. See guardRemoval below for why neither alone is
// enough.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { assertAllowed, assertContained, isAllowedDirectory, isCanonicalJson, serializeSettings, settingsReformattedNote } from './apply-lib.mjs';
import { readJsonFile } from './read-json.mjs';
import { classify, MANIFEST_PATH, replaceFile, writeManifest } from './manifest.mjs';
import { revertPatches } from './settings-merge.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { carriesStamp } from './render.mjs';
import { BOOTSTRAP_PATH, RULES_PATH, GENERATOR_SCRIPT_PATHS, HOOK_MODULE_PATHS, protectedDenyRules, toolGateDenyRules } from './propose.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import { listFiles } from './scan.mjs';
import { detectStack } from './detect-stack.mjs';
import { GATES_PATH, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules } from '../../assets/scripts/harness-redact.mjs';

const SETTINGS = '.claude/settings.json';

/**
 * This machine's session log for the repository: its directory, the bytes of
 * the regular files under it, and how many entries could not be read, so a
 * size is never presented as complete when it is not. Null when there is no
 * such directory. The log is data, not installation: uninstall reports it
 * and never removes it. A link inside it is not followed, because what it
 * points at is not the log's.
 */
function sessionLogUsage(root) {
  const location = repoDataDir(root);
  try {
    if (!fs.lstatSync(location).isDirectory()) return null;
  } catch {
    return null;
  }
  let bytes = 0, unread = 0;
  const pending = [location];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unread += 1;
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        try {
          bytes += fs.lstatSync(path).size;
        } catch {
          unread += 1;
        }
      }
    }
  }
  return { location, bytes, unread };
}

/**
 * What our generators could have written into this repository's settings,
 * the provenance `revertPatch` demands before removing a patch. Deny rules
 * are derived from the repository as it stands now, the same evidence the
 * generator reads; a rule whose evidence has since gone is kept, never
 * guessed at. The protected-surface rules rest on no evidence, so they are
 * always producible.
 *
 * No candidate glob may ever match a file the kit itself generates: those
 * files are deleted before `runUninstall` rebuilds this set, so a rule
 * resting on one would stop being producible and be kept.
 */
function producibleSettings(root) {
  const { files } = listFiles(root);
  const stack = detectStack(root, files);
  return {
    producibleHookScripts: new Set(GENERATOR_SCRIPT_PATHS),
    producibleDenyRules: new Set([...protectedDenyRules({ stack, files }), ...toolGateDenyRules()]),
  };
}

/**
 * CRITICAL (coordinator finding): the manifest is a file IN the repository
 * — a contributor, a dependency's postinstall script, a crafted repo, or
 * an agent mid-session can all write to it, same as any other file. A
 * forged entry `{"path":"CLAUDE.md","sha256":<the file's real hash>}`
 * made `classify` return `ours-unmodified` for the user's own hand-written
 * CLAUDE.md (the hash check only proves the CONTENT matches what the
 * manifest claims, never that kh-harness wrote it), and uninstall deleted
 * it. `CLAUDE.md` is inside apply-lib.mjs's write allowlist, so that gate
 * does not help either.
 *
 * Two independent fixes, deliberately both kept, because they catch
 * different forgeries (see each one's own comment, and the tests named
 * after them):
 *
 *   1. `isGeneratorProducible` — the STRUCTURAL fix. A forged entry for a
 *      path no generator ever targets (`CLAUDE.md` — P1.instructions is
 *      prompt-gated, apply.mjs has no generator for it at all) is refused
 *      regardless of content, hash, or anything else. This is the
 *      narrower, cheaper check and it is dependency-free: it only reads
 *      the manifest's OWN path string.
 *   2. `carriesStamp` — the GENERAL fix. A forged entry for a path that
 *      genuinely IS one of ours (e.g. `scripts/bootstrap.sh`, legitimately
 *      producible) but whose on-disk content is the USER's own, unrelated
 *      file (with a coincidentally-matching hash recorded for it) is
 *      refused because that content does not carry the
 *      `Generated by kh-harness` marker every real generator writes.
 *      `isGeneratorProducible` cannot catch this — the path is legitimate.
 *
 * Conversely: `carriesStamp` alone cannot catch a forged `CLAUDE.md`
 * whose content happens to mention kh-harness in ordinary prose (a user
 * is free to write "see kh-harness's own generated by kh-harness note"
 * in their own instructions) — only `isGeneratorProducible` refuses that,
 * structurally, because the path itself is never one this tool writes.
 * Neither check is redundant with the other.
 *
 * THE TWO ABOVE ARE NOT JOINTLY EXHAUSTIVE, and this enumeration used to
 * read as though they were. Whole-branch review, F6 found the third case:
 *
 *   3. A path that is genuinely ours, holding content that genuinely
 *      descends from our scaffold, INTO WHICH THE USER HAS SINCE WRITTEN
 *      THEIR OWN WORK. Both gates pass — the path is producible, and the
 *      content still carries the stamp because the user added to our file
 *      rather than replacing it — so a forged hash deletes their work.
 *      Reproduced: a `.claude/rules/packages-api.md` filled in with a
 *      package's review conventions, removed and reported as a plain
 *      `Removed:`, not kept, not refused, not flagged.
 *
 * `hasUserAuthoredBody` is the third gate, and it is the discriminator that
 * fits this class of artefact rather than a third general-purpose hash: for
 * every markdown file this tool generates from a template, the whole of our
 * own body lives in regions markdown treats as non-content (YAML
 * frontmatter, HTML comments, headings) PLUS a fixed preamble the template
 * itself holds. So "strip those and compare what is left against the
 * template's own leftover" distinguishes our scaffold from a scaffold with
 * the user's conventions in it — structurally, not by a hash anyone with
 * write access can rewrite. This is the same reasoning the gap model
 * already applies to this artefact (P1.pathrules credits a user's OWN rule
 * files, because for a path rule "the value is its content, not its
 * presence"); here it decides what must never be deleted.
 *
 * EVERY SHIPPED ARTEFACT, audited for the same hole, because the point of
 * F6 is that an enumeration which looks exhaustive is worse than one that
 * admits what it leaves out:
 *
 *   `.claude/rules/*.md`  user-content body, BY DESIGN — the proposal text
 *                         literally tells them "conventions are added by
 *                         hand afterward". COVERED by gate 3.
 *   `HANDOFF.md`          user-content body, by design — the template is a
 *                         skeleton of prompts and nothing else. Same hole,
 *                         same gate: COVERED, and the test for it sits
 *                         beside the rule-file one.
 *   `scripts/bootstrap.sh`
 *                         NOT covered, and cannot be by this gate: its body
 *                         is `{{steps}}`, derived from detection, so there
 *                         is no fixed scaffold to compare a remainder
 *                         against — and the template's own closing comment
 *                         does invite the user to answer a question in it.
 *                         Accepted residual: an honest manifest still keeps
 *                         an edited copy (`ours-modified`), so defeating
 *                         this needs a forged hash, and anyone who can
 *                         forge the manifest can delete the file outright.
 *                         Stated, not hidden.
 *   `.claude/scripts/*.mjs` (every hook script and shared module)
 *                         NOT covered, and deliberately not: these are OUR
 *                         code, copied verbatim, and their value is the
 *                         behaviour we wrote rather than anything the user
 *                         writes into them. Same accepted residual as
 *                         bootstrap.sh.
 *   `docs/harness/CLAUDE.proposed.md`
 *                         Not here at all: the SKILL drafts it (a prompt),
 *                         `apply` never writes it, so nothing of ours can be
 *                         recorded there. `CLAUDE.md` itself is refused by
 *                         gate 1 regardless of content.
 */
const GENERATOR_PRODUCIBLE_EXACT = new Set([
  'HANDOFF.md',
  BOOTSTRAP_PATH,
  // Every hook script a generator installs, so a new one is removable
  // without an edit here.
  ...GENERATOR_SCRIPT_PATHS,
  ...HOOK_MODULE_PATHS,
  // Phase 3: the rules-registry scaffold. The registry is the third artefact
  // whose designed workflow is the user writing into our file (see
  // `templateFor` and `hasUserAuthoredBody`).
  RULES_PATH,
  // Written into by a person, like the registry.
  FAILURES_PATH,
  // The two files a landed learning is written into (learn-land.mjs),
  // removable only while they hold no learning (see `ownContentRefusal`).
  LEARNED_PATH,
  GATES_PATH,
]);
// `.claude/rules/<slug>.md` — one per non-root workspace package, a path
// pathrules-evidence.mjs derives dynamically from the repository's own
// layout, so no finite exact-path list can enumerate it in advance.
const GENERATOR_PRODUCIBLE_PREFIXES = ['.claude/rules/'];

function isGeneratorProducible(relPath) {
  return GENERATOR_PRODUCIBLE_EXACT.has(relPath) || GENERATOR_PRODUCIBLE_PREFIXES.some(p => relPath.startsWith(p));
}

/**
 * Task 9b, finding 4 (and coordinator round 2, finding 2 — "the one I care
 * most about"): the same allowlist-and-containment discipline
 * `guardRemoval` applies to a FILE, applied to a DIRECTORY this tool's own
 * manifest (`dirsCreated`, recorded by apply-lib.mjs's `recordCreatedDirs`
 * at the moment of creation) says it created. The manifest is a file in
 * the repository, forgeable like any other (see this file's own header
 * comment on the CRITICAL finding for `files`) — a crafted `dirsCreated`
 * entry such as `"../../important"` must be refused the same way a forged
 * file entry is, before `rmdirSync` ever sees it.
 *
 * `isAllowedDirectory` (apply-lib.mjs) is the allowlist question, read
 * from the SAME `ALLOWED_EXACT`/`ALLOWED_PREFIXES` constants `assertAllowed`
 * uses for writes — this file used to carry its own, separately-maintained
 * copy of that list, which is exactly the shape of defect this project has
 * removed before: two pieces of code answering the same question
 * independently, each looking harmless on the day it was written. Only the
 * path-syntax safety check (absolute path, `..`) is still done here,
 * directly — that part has no "allowed" question to share, and
 * `assertContained` below is the same filesystem-containment check
 * `applyProposals` runs before every write.
 */
function assertDirRemovable(root, relDir) {
  const normalized = relDir.split('\\').join('/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`not allowed: absolute path: ${relDir}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`not allowed: path traversal: ${relDir}`);
  }
  if (!isAllowedDirectory(normalized)) {
    throw new Error(`not allowed: "${relDir}" is outside the directory-removal allowlist`);
  }
  assertContained(root, normalized);
}

/**
 * Task 9b (coordinator round 2, finding 1): the read-only PREDICTION
 * (`planUninstall`, for the dry-run preview) and the real REMOVAL
 * (`runUninstall`) must decide "is this directory removable" the exact
 * same way, or the preview can promise a cleanup `--yes` doesn't actually
 * perform (or the reverse). This is that one shared decision, structured
 * so the two callers cannot drift: it NEVER touches the filesystem itself
 * — it only reads (`existsSync`/`readdirSync`) and decides.
 *
 * `gone` is the set of relative paths — files AND, as this function finds
 * them, directories — that are to be treated as already removed. For a
 * REAL run that is the actual outcome of every earlier step (file removals,
 * the settings-file cleanup, the manifest's own fate), queried against the
 * real, still-mutating filesystem. For a PREDICTION it is the plan's own
 * best guess at that same set, queried against the filesystem as it stands
 * right now — which is why a prediction can go stale between plan and run
 * the same way `plan.revert`/`plan.remove` already can (see this file's own
 * comments on `revertPatch`/`classify` being re-derived, never replayed).
 *
 * Processes deepest-first (a shallower directory can only become removable
 * once everything recorded under it already is) and mutates `gone` by
 * adding each directory it finds removable, so a shallower ancestor in the
 * SAME pass correctly sees it as gone too. Returns the ordered list of
 * directories decided removable — never one that is missing already
 * (nothing to do), never one outside the allowlist or that escapes the
 * repository (`assertDirRemovable`), and never one still holding anything,
 * ours or the user's, that isn't ALSO already in `gone`.
 */
function sweepRemovableDirs(root, dirsCreated, gone) {
  const removable = [];
  const sorted = [...dirsCreated].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of sorted) {
    try {
      assertDirRemovable(root, dir);
    } catch {
      continue; // a forged or out-of-scope entry is never acted on
    }
    const abs = join(root, dir);
    let entries;
    try {
      if (!fs.existsSync(abs)) continue; // already gone; nothing to predict or remove
      entries = fs.readdirSync(abs);
    } catch {
      continue;
    }
    const allAccountedFor = entries.every(name => gone.has(`${dir}/${name}`));
    if (!allAccountedFor) continue; // still holds something not already accounted for
    gone.add(dir);
    removable.push(dir);
  }
  return removable;
}

/**
 * The REAL removal: calls `sweepRemovableDirs` against `gone` built from
 * this run's own ACTUAL outcomes (never the plan's prediction — see that
 * function's own comment), then physically removes each directory it
 * names, in the same deepest-first order, skipping (never throwing on) a
 * `rmdirSync` failure — the same safe-failure direction every other
 * removal guard in this module already takes. Returns the subset actually
 * removed, so the caller can prune the manifest to match reality rather
 * than its own stale guess.
 */
function removeEmptyCreatedDirs(root, dirsCreated, gone) {
  const candidates = sweepRemovableDirs(root, dirsCreated, gone);
  const removedDirs = [];
  for (const dir of candidates) {
    try {
      fs.rmdirSync(join(root, dir));
      removedDirs.push(dir);
    } catch {
      // Leave it.
    }
  }
  return removedDirs;
}

// --- The third gate: a body the user wrote (whole-branch review, F6) ------

const TEMPLATES = new URL('../../assets/templates/', import.meta.url);

/**
 * The template a generated markdown artefact came from, or null when this
 * gate has nothing to say about the path.
 *
 * `.claude/rules/` is prefix-matched for the same reason
 * `GENERATOR_PRODUCIBLE_PREFIXES` is: the slug is derived from the
 * repository's own layout, so no exact list can enumerate it in advance.
 */
function templateFor(relPath) {
  if (relPath === 'HANDOFF.md') return 'HANDOFF.md.tmpl';
  if (relPath.startsWith('.claude/rules/') && relPath.endsWith('.md')) return 'path-rule.md.tmpl';
  // The registry's whole scaffold body is one HTML comment under one
  // heading (propose.mjs's `rulesScaffoldProposal`), so a filled-in
  // registry — the user's own rules — is exactly what `markdownRemainder`
  // surfaces as user-authored, and this gate keeps it.
  if (relPath === RULES_PATH) return 'RULES.md.tmpl';
  if (relPath === FAILURES_PATH) return 'FAILURES.md.tmpl';
  return null;
}

/**
 * What is left of a markdown file once everything our own generators put in
 * it has been removed: YAML frontmatter (only when it opens the file),
 * every HTML comment, every ATX heading line, and all whitespace
 * differences.
 *
 * LOAD-BEARING, and the reason this can be compared against the RAW
 * template without rendering it: every placeholder in every shipped
 * markdown template sits inside a region this function strips, and so does
 * every value it renders to. `{{glob}}` is inside the frontmatter;
 * `{{dir}}` is inside a heading; `{{stamp}}` renders to an HTML comment.
 * So stripping `{{...}}` here leaves exactly what stripping the RENDERED
 * values leaves, and the comparison is independent of the kit version, the
 * package name and the glob. If a future template ever puts a placeholder
 * in ordinary body text, that equivalence breaks — which is why
 * uninstall-lib.test.mjs asserts it against the output of the REAL
 * generators rather than trusting this comment.
 *
 * Whitespace is collapsed so a CRLF checkout, a reflowed paragraph or a
 * trailing-newline difference is not mistaken for the user's writing.
 */
export function markdownRemainder(text) {
  return String(text)
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
    .replace(/\{\{\w+\}\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '')
    .replace(/^[ \t]*#{1,6}(?:[ \t].*)?$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a generated markdown artefact holds body text our own scaffold
 * does not — i.e. the user's own work, which must never be deleted however
 * convincing the manifest is.
 *
 * Fails CLOSED on every uncertainty, like `carriesStamp` and `classify`:
 * a file that cannot be read, or a template that cannot be read, means we
 * cannot PROVE the body is still only ours, so it is treated as the user's
 * and kept. The cost of a wrong "keep" is a leftover file the user can
 * delete; the cost of a wrong "remove" is their work.
 *
 * Known residual, stated rather than hidden: a user who adds ONLY a heading
 * and no body text is not distinguished from our scaffold by this gate.
 * `classify` still keeps that file under an honest manifest (it is
 * `ours-modified`), so defeating it needs a forged hash AND an edit that is
 * nothing but a heading. That is narrow enough to accept, and it is written
 * down here so the next reader does not have to rediscover that this gate,
 * too, is not exhaustive.
 */
function hasUserAuthoredBody(root, relPath) {
  const template = templateFor(relPath);
  if (template === null) return false;
  let text;
  try {
    text = fs.readFileSync(join(root, relPath), 'utf8');
  } catch {
    return true; // cannot read it, so cannot prove it is still only ours
  }
  let scaffold;
  try {
    scaffold = fs.readFileSync(new URL(template, TEMPLATES), 'utf8');
  } catch {
    return true; // cannot read our own template either
  }
  return markdownRemainder(text) !== markdownRemainder(scaffold);
}

/**
 * How many learnings the learned file at `relPath` holds: the registry's
 * entries, or the gate file's gates. Null when the file cannot be read as
 * one, which is not shown to hold none.
 */
function learningsHeld(root, relPath) {
  let text;
  try {
    text = fs.readFileSync(join(root, relPath), 'utf8');
  } catch {
    return null;
  }
  if (relPath === LEARNED_PATH) return parseRules(text).rules.length;
  try {
    const gates = JSON.parse(text)?.gates;
    return Array.isArray(gates) ? gates.length : null;
  } catch {
    return null;
  }
}

const LEARNED_PARTNER = Object.freeze({ [LEARNED_PATH]: GATES_PATH, [GATES_PATH]: LEARNED_PATH });

/**
 * Every content-level reason a recorded file may not be removed, in one
 * place, so the dry run's prediction and the real removal decide it
 * identically: `{ why }`, with `learnings` when the reason is the learnings
 * the file holds and `partner` when it is the other learned file being
 * kept, or null when the content permits removal.
 *
 * The two learned files are decided together: if either is kept for any
 * reason, both are, so a committed gate is never left without its registry
 * entry, nor an entry that claims an approval without its gate.
 */
function contentRefusal(root, manifest, relPath) {
  const own = ownContentRefusal(root, manifest, relPath);
  if (own !== null) return own;
  const partner = LEARNED_PARTNER[relPath];
  if (partner !== undefined && fs.existsSync(join(root, partner)) && (guardRemoval(root, partner) !== null || ownContentRefusal(root, manifest, partner) !== null)) {
    return { why: 'learned-partner-kept', partner };
  }
  return null;
}

/**
 * `contentRefusal` for the file alone, without its learned partner.
 *
 * A landed learning is the owner's content, as a filled rules registry is:
 * the owner approved it, and this machine's ledger still records it as
 * landed. So a learned file that holds any learning is kept, whatever the
 * manifest says of it, and `learn revert` is what takes each one out. One
 * that cannot be read as a learned file is not shown to hold none.
 */
function ownContentRefusal(root, manifest, relPath) {
  if (Object.hasOwn(LEARNED_PARTNER, relPath) && fs.existsSync(join(root, relPath))) {
    const learnings = learningsHeld(root, relPath);
    if (learnings === null) return { why: 'unreadable-learned-file' };
    if (learnings > 0) return { why: 'holds-landed-learnings', learnings };
  }
  const state = classify(root, manifest, relPath);
  if (state !== 'ours-unmodified') return { why: state };
  // The hash matches what the manifest claims, which a forged entry naming
  // the owner's own file with its real hash also produces: the file must
  // carry the stamp too before it is the kit's to delete.
  if (!carriesStamp(root, relPath)) return { why: 'missing-stamp' };
  // And for the artefacts the owner is meant to write into, a stamped file
  // that holds their writing is theirs.
  if (hasUserAuthoredBody(root, relPath)) return { why: 'user-authored-body' };
  return null;
}

// What `guardRemoval` answers for a recorded file that is no longer on disk.
const ALREADY_GONE = 'already-gone';

/**
 * Whether the recorded path may be removed at all, before its content is
 * read: null when it may, `ALREADY_GONE` when there is nothing there to
 * remove, otherwise the reason to record against the entry that is kept.
 *
 *   - A manifest naming `src/index.ts` or `package.json` resolves happily
 *     inside the repository. Containment passes it; only the allowlist
 *     refuses it.
 *   - A junction at `docs/harness` pointing outside the repository, with a
 *     manifest entry naming `docs/harness/victim.txt` whose hash still
 *     matches, is on the allowlist. Only containment refuses it. Moving
 *     `docs/harness` elsewhere and leaving a junction behind is enough: the
 *     contents are unchanged, so the hashes still match.
 *   - A forged manifest entry for `CLAUDE.md` is allowed and contained.
 *     Only `isGeneratorProducible` refuses it.
 *
 * A file that is not there is asked about only once the path is known to be
 * allowed and inside the repository, so nothing outside it is probed. It is
 * not kept: the owner deleted it, there is nothing left to protect, and a
 * record of it would keep the manifest in the repository for good.
 *
 * A refusal is returned, never thrown. Uninstall has to finish its work and
 * report honestly even when the state on disk is strange; a throw here would
 * abandon the run between an action and its bookkeeping.
 */
function guardRemoval(root, relPath) {
  try {
    assertAllowed(relPath);
  } catch {
    return 'outside-allowlist';
  }
  try {
    assertContained(root, relPath);
  } catch {
    return 'escapes-repository';
  }
  if (!fs.existsSync(join(root, relPath))) return ALREADY_GONE;
  if (!isGeneratorProducible(relPath)) {
    return 'not-generator-producible';
  }
  return null;
}

/**
 * Reads and validates `.claude/settings.json`.
 *
 * Three outcomes, deliberately not collapsed into two. An absent file is not
 * a failure — there is no hook left to remain registered — while a file that
 * exists but cannot be read, or is not a JSON object, is. An EACCES, a
 * syntax error and a deleted file must not be indistinguishable to a user.
 */
function validateSettings(settingsPath) {
  const read = readJsonFile(settingsPath);
  if (read.state === 'absent') return { valid: false, object: null, reason: 'settings-missing', raw: null };
  if (read.state === 'unreadable') return { valid: false, object: null, reason: 'settings-unreadable', raw: null };
  const isPlain = typeof read.value === 'object' && read.value !== null && !Array.isArray(read.value);
  if (isPlain) return { valid: true, object: read.value, reason: null, raw: read.text };
  return { valid: false, object: null, reason: 'settings-unreadable', raw: read.text };
}

/**
 * Read-only. Decides what may be removed; removes nothing. `gone` and
 * `gonePatches` are what the manifest records that is no longer there, a
 * file or a settings entry: nothing is done about either, and the run drops
 * both from the record.
 */
export function planUninstall({ root, manifest }) {
  const remove = [], keep = [], gone = [], revert = [], keepPatches = [], gonePatches = [];

  for (const f of manifest?.files ?? []) {
    const refusal = guardRemoval(root, f.path);
    if (refusal === ALREADY_GONE) {
      gone.push({ path: f.path });
      continue;
    }
    if (refusal) {
      keep.push({ path: f.path, why: refusal });
      continue;
    }
    const content = contentRefusal(root, manifest, f.path);
    if (content) {
      keep.push({ path: f.path, ...content });
      continue;
    }
    remove.push({ path: f.path });
  }

  // The same revert `runUninstall` performs, done here read-only, so the
  // prediction of the settings file's final content, below, asks the
  // question the real run answers.
  const validated = validateSettings(join(root, SETTINGS));
  const patches = manifest?.settingsPatches ?? [];
  let simulatedSettings = validated.valid ? validated.object : null;
  if (validated.reason === 'settings-missing') {
    // No settings file means no hook is registered: there is nothing to
    // revert and nothing left behind.
    for (const p of patches) gonePatches.push({ ...p, why: validated.reason });
  } else if (!validated.valid) {
    for (const p of patches) keepPatches.push({ ...p, why: validated.reason });
  } else if (patches.length > 0) {
    const r = revertPatches(simulatedSettings, patches, producibleSettings(root));
    simulatedSettings = r.settings;
    revert.push(...r.reverted);
    for (const p of r.gone) gonePatches.push({ ...p, why: 'entry-gone' });
    for (const k of r.kept) keepPatches.push({ ...k.patch, why: k.reason });
  }

  // The preview is the path a cautious user reaches for first, so it
  // predicts the settings-file and directory cleanup `--yes` performs, by
  // the questions the real run asks of its own outcome.
  const removeSettingsFile = Boolean(manifest?.settingsCreated) && validated.valid &&
    typeof simulatedSettings === 'object' && simulatedSettings !== null && !Array.isArray(simulatedSettings) &&
    Object.keys(simulatedSettings).length === 0;

  // As `runUninstall` decides it: the manifest goes when nothing is kept.
  // A file that changes between plan and run cannot be predicted here.
  const predictedManifestGone = keep.length === 0 && keepPatches.length === 0;

  const accountedFor = new Set(remove.map(r => r.path));
  if (removeSettingsFile) accountedFor.add(SETTINGS);
  if (predictedManifestGone) accountedFor.add(MANIFEST_PATH);
  const removeDirs = sweepRemovableDirs(root, manifest?.dirsCreated ?? [], accountedFor);

  return {
    remove, keep, gone, revert, keepPatches, gonePatches,
    removeSettingsFile: removeSettingsFile ? SETTINGS : null,
    removeDirs,
    leftInPlace: fs.existsSync(join(root, DETECT_REPORT_PATH)) ? [DETECT_REPORT_PATH] : [],
    sessionLog: sessionLogUsage(root),
  };
}

export function runUninstall({ root, manifest, plan }) {
  // Every outcome is collected before anything is persisted, and nothing
  // throws between an action and its bookkeeping.
  const removed = [], failed = [], refused = [], alreadyGone = [], changedSincePlan = [];
  let settingsReadFailed = false, settingsMissing = false;
  let settingsWriteFailed = false, manifestWriteFailed = false;
  let settingsReformatted = false;
  const patchesNotReverted = [];
  // Declined for lack of provenance: a deliberate keep, like a file this run
  // will not delete, and not a failure.
  const patchesKept = [];
  const patchesGone = [];

  // 1. Guard, re-classify, re-check the stamp, and remove only what still
  //    passes. `plan` may have been built before the junction, entry or
  //    edit that makes a path unsafe existed, or by a caller that is not
  //    `planUninstall`.
  for (const r of plan.remove) {
    const refusal = guardRemoval(root, r.path);
    if (refusal === ALREADY_GONE) {
      alreadyGone.push(r.path);
      continue;
    }
    if (refusal) {
      refused.push({ path: r.path, why: refusal });
      continue;
    }
    const content = contentRefusal(root, manifest, r.path);
    if (content !== null) {
      changedSincePlan.push({ path: r.path, ...content });
      continue;
    }
    try {
      fs.rmSync(join(root, r.path));
      removed.push(r.path);
    } catch (e) {
      failed.push({ path: r.path, reason: e?.message ?? 'unknown error' });
    }
  }
  // A file the plan found gone is dropped from the record only if it is
  // still gone: one that is back was never shown to the owner as removable.
  for (const g of plan.gone ?? []) {
    if (fs.existsSync(join(root, g.path))) changedSincePlan.push({ path: g.path, why: 'reappeared' });
    else alreadyGone.push(g.path);
  }

  // 2. Revert the settings patches. What can be reverted is derived from
  //    the manifest and the file as it is now, never replayed from
  //    `plan.revert`: the owner may have repaired an unparseable file since
  //    the plan, and a patch the plan never saw must still be accounted for.
  const manifestPatches = manifest?.settingsPatches ?? [];
  if (manifestPatches.length > 0) {
    const validated = validateSettings(join(root, SETTINGS));

    if (validated.valid) {
      const r = revertPatches(validated.object, manifestPatches, producibleSettings(root));
      patchesGone.push(...r.gone);
      for (const k of r.kept) {
        (k.reason === 'not-generator-producible' ? patchesKept : patchesNotReverted).push({ ...k.patch, why: k.reason });
      }
      // Written only when something was reverted: a run that reverts
      // nothing has no business rewriting the owner's settings.json.
      if (r.reverted.length > 0) {
        try {
          replaceFile(join(root, SETTINGS), serializeSettings(r.settings, validated.raw));
          // Asked of the file as it was before this run, not of the revert.
          settingsReformatted = !isCanonicalJson(validated.raw);
        } catch {
          settingsWriteFailed = true;
          // Nothing reached disk, so every patch reverted in memory is still
          // registered. Each is recorded by identity: two patches under one
          // event share a container, and a record dropped here is a hook
          // left registered with no record of it anywhere.
          for (const p of r.reverted) patchesNotReverted.push({ ...p, why: 'settings-write-failed' });
        }
      }
    } else if (validated.reason === 'settings-missing') {
      // Nothing to revert and nothing left behind: reported, not a failure.
      settingsMissing = true;
    } else {
      // Present but unreadable, or not a plain object: as far as can be
      // told the patches are still registered.
      settingsReadFailed = true;
      for (const p of manifestPatches) {
        patchesNotReverted.push({ ...p, why: validated.reason });
      }
    }
  }

  // 2.5. Remove `.claude/settings.json` itself, but only when the manifest
  // records that the kit created it and it is now empty: never a file that
  // existed before, and never one still holding content. An unreadable or
  // unparseable file is left alone.
  let settingsRemoved = false;
  if (manifest?.settingsCreated) {
    const settingsPath = join(root, SETTINGS);
    const current = validateSettings(settingsPath);
    if (current.valid && Object.keys(current.object).length === 0) {
      try {
        fs.rmSync(settingsPath);
        settingsRemoved = true;
        removed.push(SETTINGS);
      } catch {
        // Left in place; the manifest keeps `settingsCreated` for a later run.
      }
    }
  }

  // 3. The manifest is rebuilt from what happened, not from the plan. A file
  //    stays recorded when it is kept, was refused, changed since the plan,
  //    or could not be removed; one removed or already gone does not.
  const keptPaths = new Set([
    ...plan.keep.map(k => k.path),
    ...changedSincePlan.map(c => c.path),
    ...failed.map(f => f.path),
    ...refused.map(r => r.path),
  ]);
  const keptFiles = (manifest?.files ?? []).filter(f => keptPaths.has(f.path));

  // A patch stays recorded when this run could not revert it, each with the
  // reason computed for it: the record is the half that survives the
  // process, and it must not disagree with what the caller is told.
  const keptPatches = [...patchesNotReverted, ...patchesKept].map(p => ({ ...p }));

  // 4. Persist the manifest once. With no file and no patch left to record
  //    it is removed, whatever else it holds.
  let manifestDeleteFailed = false;
  const hasKept = keptFiles.length > 0 || keptPatches.length > 0 || changedSincePlan.length > 0;
  const hasFailures = failed.length > 0;

  // 4.5. Directories the kit created (`dirsCreated`) are removed once they
  // are empty: never one that existed beforehand, which was never recorded,
  // and never one that still holds something. The manifest lives in
  // `.claude/`, so that directory can only empty when this run deletes the
  // manifest first; when the manifest stays, the sweep runs before the one
  // write that records its result.
  //
  // The set of paths already accounted for starts empty here: everything
  // this run removed is off the disk, so `readdirSync` already shows it.
  const dirsCreated = manifest?.dirsCreated ?? [];
  let removedDirs = [];
  if (!hasKept && !hasFailures) {
    try {
      fs.rmSync(join(root, MANIFEST_PATH));
    } catch {
      manifestDeleteFailed = true;
    }
    if (dirsCreated.length) removedDirs = removeEmptyCreatedDirs(root, dirsCreated, new Set());
  } else {
    if (dirsCreated.length) removedDirs = removeEmptyCreatedDirs(root, dirsCreated, new Set());
    const updatedManifest = {
      ...manifest,
      files: keptFiles,
      settingsPatches: keptPatches,
      dirsCreated: dirsCreated.filter(d => !removedDirs.includes(d)),
      settingsCreated: settingsRemoved ? false : (manifest?.settingsCreated ?? false),
    };
    // A learning is recorded as landed only beside the record of the gate
    // file that holds it.
    if (manifest?.learnings !== undefined && !keptPaths.has(GATES_PATH)) updatedManifest.learnings = [];
    try {
      writeManifest(root, updatedManifest);
    } catch {
      manifestWriteFailed = true;
    }
  }

  return {
    removed,
    failed,
    refused,
    alreadyGone,
    settingsReadFailed,
    settingsMissing,
    settingsWriteFailed,
    settingsReformatted,
    manifestWriteFailed,
    manifestDeleteFailed,
    changedSincePlan,
    patchesNotReverted,
    patchesKept,
    patchesGone,
    removedDirs,
    leftInPlace: fs.existsSync(join(root, DETECT_REPORT_PATH)) ? [DETECT_REPORT_PATH] : [],
  };
}
