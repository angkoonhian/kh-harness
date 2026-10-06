// scripts/lib/detect-exposure.mjs
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_BYTES = 512 * 1024;

// `token-in-repo-file` is NOT called `token-in-tracked-file`, and must not be
// renamed back. This scanner walks the filesystem; it never consults the git
// index, so it cannot know whether a file is tracked. Under the old name it
// asserted tracking it had not checked: run against a real repository it
// labelled three files `token-in-tracked-file` that `git ls-files` did not
// know and that had zero commits touching them. The exposure was real; the
// kind was a claim the detector had no evidence for, which is the one thing
// this tool is not allowed to do. If a genuine tracked/untracked split is
// wanted later, it needs the git index as an input, not a new name.
//
// Always-probed paths (e.g., .gitignored local settings)
// The two files `token-in-local-settings` actually names. Whole-branch
// review, F8 (the trailing "related, same module, trivial" note): the test
// used to be `rel.startsWith('.claude/')`, which reported a token in, say,
// `.claude/scripts/lint-touched.mjs` under a kind that names a different
// file. A token anywhere else under `.claude/` is an ordinary
// `token-in-repo-file`.
const LOCAL_SETTINGS_FILES = new Set(['.claude/settings.json', '.claude/settings.local.json']);

const ALWAYS_PROBE = [
  '.claude/settings.local.json',
  '.claude/settings.json',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.netrc',
];

const TOKEN_PATTERNS = [
  /glpat-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const DB_CRED = /(password|passwd|pwd)\s*[:=]\s*(\S{8,})/i;

const PLACEHOLDER =/(your[-_]|<|xxx|example|changeme|placeholder|dummy|redacted|^(password|secret|todo)$)/i;

// Task 9b, finding 1: a credential-shaped key (`password:`, `pwd=`, ...)
// whose VALUE is a code reference — a property access, a function call, or a
// subscript, e.g. `process.env.TOKEN`, `config.get('x')`, `os.environ["K"]`,
// `self.password`, `settings.SECRET_KEY` — is ordinary source code reading a
// secret from somewhere else, not a secret written in the file. On a real
// TypeScript codebase this shape was 62 of 66 `credentials-in-doc` hits: noise
// loud enough to bury the one real finding and four plausible ones beneath it.
//
// This is syntactic, not a parser: a reference is an identifier, optionally
// extended by one or more `.prop`, `(...)`, or `[...]` segments, and NOTHING
// else — the whole value, start to end. Deliberately conservative, per the
// standing ruling that a guard which misses a real secret is worse than one
// that over-reports: a bare identifier with NO such extension (`SECRET_KEY`
// alone), a quoted string, a `glpat-`-shaped token (a literal that merely
// STARTS with identifier characters before hitting a `-` the pattern below
// does not accept as a continuation), and an empty string all fail to match
// and are therefore classified `literal` — prominent, exactly as before this
// fix. Only a genuine compound reference expression is ever classified
// `reference`. When in doubt, this returns `literal`.
const REFERENCE_VALUE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^()]*\)|\[[^[\]]*\])+[;,]?$/;

/**
 * Classifies a `credentials-in-doc` match's VALUE half (never the key) as
 * `'literal'` (a real string/token — stays a prominent finding) or
 * `'reference'` (code reading a secret from elsewhere — collapsed to a count
 * by report.mjs/gap-model.mjs, never suppressed or dropped here). This
 * function only tags; it never decides what is shown or counted as a
 * failure — see detectExposures below, which runs it over every DB_CRED
 * match and records the result on the finding, and splitExposures /
 * isProminentExposure, which downstream callers use to decide presentation.
 */
export function classifyCredentialValue(value) {
  if (typeof value !== 'string' || value.length === 0) return 'literal';
  return REFERENCE_VALUE.test(value) ? 'reference' : 'literal';
}

/**
 * Not a credential finding: a file the scan list NAMED that this sweep could
 * not read, so it was never examined at all.
 *
 * Whole-branch review, F1. The defect was not git's path quoting — that was
 * only how the unreadable path got here. The defect was that `scannable`'s
 * `catch { return false }` turned "I could not look at this file" into "there
 * is nothing here", with no record anywhere that a file had been skipped, and
 * `P0.security` then reported `verified / no credential patterns matched` over
 * a plaintext token. A security check that reports success because it never
 * read the file inverts this project's whole doctrine, and the quoting fix
 * alone would leave that inversion in place for every OTHER reason a read can
 * fail (EACCES, a file deleted between the scan and the read, a path outside
 * the tree, a filesystem error). So: an unexpected read failure is a FINDING,
 * carried on the same list every other Phase-0 finding is carried on, and
 * `P0.security` cannot be `verified` while one exists.
 *
 * Deliberately NOT reported: the skips this module makes ON PURPOSE and
 * states in code — `SKIP_DIRS`, `SKIP_EXT` (a PNG is not unexamined, it is
 * not text), a non-regular file such as a submodule gitlink, and a file over
 * `MAX_BYTES`. Reporting those would make `P0.security` `failing` on every
 * real repository, which is its own false report and would teach a reader to
 * skip the one line in this tool they are most likely to act on. The honest
 * treatment of a deliberate skip is a `verified` sentence that claims only
 * what was actually read — see gap-model.mjs's `CLEAN_SWEEP_NOTE` — not an
 * alarm.
 */
export const UNREADABLE_KIND = 'file-unreadable';

/** True for every exposure that must stay individually visible: every kind
 * OTHER than `credentials-in-doc`, and a `credentials-in-doc` finding whose
 * value is a literal rather than a code reference. An `UNREADABLE_KIND`
 * finding is always prominent: it is the one thing that must never be
 * collapsed, since it is the record that the sweep is incomplete. */
export function isProminentExposure(e) {
  return !(e.kind === 'credentials-in-doc' && e.valueKind === 'reference');
}

/** Splits a full exposure list into the ones that must stay prominent and a
 * bare count of the rest (credential-shaped keys holding a code reference,
 * not a literal) — never the entries themselves, so a caller cannot
 * accidentally re-individualise what this exists to collapse. */
export function splitExposures(exposures) {
  const prominent = exposures.filter(isProminentExposure);
  return { prominent, collapsedCount: exposures.length - prominent.length };
}

/**
 * `prominent` (from `splitExposures`) split again, into the credential
 * findings the Exposures section lists and the files the sweep could not
 * examine. Shared — like `splitExposures` itself — so `P0.security`'s own
 * evidence (gap-model.mjs) and the rendered sections (report.mjs) can never
 * disagree about which of the two a finding is, or how many there are of
 * each. Returns both lists; callers decide presentation, never membership.
 */
export function partitionProminent(prominent) {
  return {
    credentials: prominent.filter(e => e.kind !== UNREADABLE_KIND),
    unreadable: prominent.filter(e => e.kind === UNREADABLE_KIND),
  };
}

/** The one shared sentence for the collapsed class, so detect's Phase-0
 * evidence and the Exposures section always say exactly the same thing. */
export function collapsedExposureNote(count) {
  const s = count === 1 ? '' : 's';
  const isAre = count === 1 ? 'is a' : 'are';
  return `${count} credential-shaped key${s} whose value${s} ${isAre} code reference${s} (not literal${s}) — listed in detect.json, not shown here`;
}

/**
 * The one shared sentence for "this sweep is incomplete". Written as one
 * place for the same reason `collapsedExposureNote` is: `P0.security` and the
 * rendered section must not be able to describe the same incompleteness two
 * different ways.
 */
export function unexaminedExposureNote(count) {
  const s = count === 1 ? '' : 's';
  const they = count === 1 ? 'it was' : 'they were';
  return `${count} file${s} named by the file scan could not be read, so ${they} NEVER examined for credentials — this sweep is INCOMPLETE; listed under "Not examined", and in detect.json as kind "${UNREADABLE_KIND}"`;
}

/**
 * Whole-branch review, F12: `P0.security`'s evidence and the Exposures
 * section printed the identical list — 14 lines carrying 7 facts — because
 * the (correct) `splitExposures` fix made the two read the same source. The
 * remedy is for the check to CITE the section rather than reproduce it: the
 * section is where the findings belong, because it is the only one of the two
 * that carries each finding's severity.
 *
 * Which test holds the "62 reference hits do not become 62 lines" guarantee
 * after this change: `report.test.mjs`'s "renderSummary shows a literal
 * credentials-in-doc hit prominently and collapses reference-valued hits to
 * one count line", which counts the rendered lines. `gap-model.test.mjs` can
 * no longer hold it, since this check's evidence is now a fixed two lines
 * whatever the input — and a test that cannot fail for the thing it is named
 * after is worse than no test (F13).
 */
export function prominentExposureNote(count) {
  const s = count === 1 ? '' : 's';
  return `${count} credential finding${s} — listed with severity under "Exposures", and in detect.json as exposures[]`;
}

// Skip binary-ish extensions: images, archives, binaries, fonts, media, source maps
const SKIP_EXT = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.jar', '.pyc', '.node', '.bin',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.wav',
  '.map',
];
const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/'];

function isBinaryExtension(base) {
  const lower = base.toLowerCase();
  return SKIP_EXT.some(e => lower.endsWith(e));
}

/**
 * Decides whether one path is examined, and — when it is not — whether that
 * is a DELIBERATE skip (`reason: null`, silent by design) or an unexpected
 * read failure (`reason` set, reported as an `UNREADABLE_KIND` finding).
 * See `UNREADABLE_KIND`'s own comment for why the two are separated rather
 * than all collapsed into one alarm.
 *
 * One function, consulted on both of `detectExposures`' two paths (the scan
 * list and `ALWAYS_PROBE`). It used to be two: `scannable` tested
 * `size <= MAX_BYTES` for scan-list entries and `scanFile` re-tested
 * `size > MAX_BYTES` for everything — the same question, asked twice, with
 * two independent `catch` clauses that disagreed about what a failed `stat`
 * meant. That is the duplicated-predicate shape this branch's review found
 * five times over; it is one predicate now.
 */
function probe(root, rel) {
  if (SKIP_DIRS.some(p => rel.startsWith(p) || rel.includes('/' + p))) return { examine: false, reason: null };
  if (isBinaryExtension(basename(rel))) return { examine: false, reason: null };
  let st;
  try {
    st = statSync(join(root, rel));
  } catch (err) {
    return { examine: false, reason: `could not be stat()ed (${err?.code ?? 'unknown error'})` };
  }
  // Not a regular file: a submodule gitlink, or a directory git listed. Already
  // disclosed as a nested repository ("each nested repository must be assessed
  // separately" — report.mjs), so not an alarm here.
  if (!st.isFile()) return { examine: false, reason: null };
  if (st.size > MAX_BYTES) return { examine: false, reason: null };
  return { examine: true, reason: null };
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(value);
}

/**
 * Read a file's text content, deciding the encoding from its bytes rather
 * than assuming UTF-8. Order matters (see task-5-report.md, fix round 4):
 *   1. UTF-16LE BOM (FF FE)  -> decode as utf16le
 *   2. UTF-16BE BOM (FE FF)  -> byte-swap then decode as utf16le
 *   3. NUL byte in first 8 KB, no BOM -> treat as binary, skip (return null)
 *   4. Otherwise decode as UTF-8, stripping a UTF-8 BOM if present.
 *
 * Known limitation: BOM-less UTF-16 (or other multi-byte-per-char encodings
 * without a BOM) is out of scope. There is no reliable, non-heuristic way to
 * distinguish it from binary content, and heuristics here have a history of
 * causing regressions (see task-5-report.md). Such files are skipped.
 *
 * Never throws: any failure decoding is treated as "not readable text".
 *
 * Returns `{ text, reason }`. `reason` is set ONLY when the bytes could not
 * be obtained at all (an `fs` failure) — that is an unexpected read failure
 * and becomes an `UNREADABLE_KIND` finding. Every decode-level "nothing to
 * read" outcome below (the NUL sniff, BOM-less UTF-16, a decoder throwing)
 * keeps `reason: null`: those are this module's own documented policy, not a
 * failure, and crying alarm over them would make the check useless.
 */
function readTextIfPresent(root, rel) {
  let buf;
  try {
    buf = readFileSync(join(root, rel));
  } catch (err) {
    return { text: null, reason: `could not be read (${err?.code ?? 'unknown error'})` };
  }

  try {
    // UTF-16LE BOM
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return { text: buf.subarray(2).toString('utf16le'), reason: null };
    }

    // UTF-16BE BOM: Node has no native utf16be decoder, so byte-swap into
    // little-endian order first.
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      let body = Buffer.from(buf.subarray(2)); // copy: swap16 mutates in place
      if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1);
      body.swap16();
      return { text: body.toString('utf16le'), reason: null };
    }

    // Binary-content sniff over the raw bytes (not a decoded string).
    const sniffLen = Math.min(buf.length, 8192);
    if (buf.subarray(0, sniffLen).includes(0)) return { text: null, reason: null };

    // UTF-8, stripping a UTF-8 BOM if present so BOM-prefixed first lines
    // still match patterns anchored at the start of the text.
    const start = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? 3 : 0;
    return { text: buf.subarray(start).toString('utf8'), reason: null };
  } catch {
    return { text: null, reason: null };
  }
}

/**
 * Scans one file that `probe` already decided is examinable. Returns
 * `{ findings, reason }` — `reason` set only when the read itself failed, so
 * the caller can record that the file went unexamined instead of returning an
 * empty `findings` list that is indistinguishable from "clean".
 *
 * The duplicate `statSync`/`MAX_BYTES` check that used to open this function
 * is gone: `probe` is the single place that answers it, for both of
 * `detectExposures`' paths.
 */
function scanFile(root, rel, isLocalSettings) {
  const findings = [];

  const { text, reason } = readTextIfPresent(root, rel);
  if (reason) return { findings, reason };
  if (!text) return { findings, reason: null };

  const hasToken = TOKEN_PATTERNS.some(re => re.test(text)) || PEM_PATTERN.test(text);
  if (hasToken) {
    const kind = isLocalSettings ? 'token-in-local-settings' : 'token-in-repo-file';
    findings.push({ kind, location: rel, severity: 'high' });
  }

  if (DB_CRED.test(text)) {
    const match = text.match(DB_CRED);
    if (match && !isPlaceholder(match[0])) {
      findings.push({
        kind: 'credentials-in-doc', location: rel, severity: 'medium',
        valueKind: classifyCredentialValue(match[2]),
      });
    }
  }

  return { findings, reason: null };
}

/**
 * Scans one path and appends whatever it found to `out` — including, when the
 * path could not be read, the `UNREADABLE_KIND` record that keeps the skip
 * from being silent. `announceMissing` is the one thing that differs between
 * `detectExposures`' two paths: a path the FILE SCAN named and that is not
 * there is a real anomaly worth reporting (that is F1 exactly — the quoted
 * literal `"src/caf\303\251.ts"` stat-ed as ENOENT), while an `ALWAYS_PROBE`
 * path is a guess at a name that usually is not there, so its absence is
 * expected and silent.
 */
function scanPath(root, rel, out, announceMissing) {
  if (!announceMissing && !existsSync(join(root, rel))) return;

  const unreadable = reason => out.push({ kind: UNREADABLE_KIND, location: rel, severity: 'high', reason });

  const p = probe(root, rel);
  if (!p.examine) {
    if (p.reason) unreadable(p.reason);
    return;
  }
  // `.claude/` holds the gitignored, machine-local settings file the kit
  // treats as a credential carrier. Whole-branch review, F8 (related note):
  // this used to label ANY finding under `.claude/` as
  // `token-in-local-settings`, so a token in `.claude/scripts/*.mjs` was
  // reported under a kind naming a file it was not in. It is now the two
  // settings files themselves, which is what the kind actually names.
  const { findings, reason } = scanFile(root, rel, LOCAL_SETTINGS_FILES.has(rel));
  if (reason) unreadable(reason);
  out.push(...findings);
}

export function detectExposures(root, files, harness) {
  const out = [];
  const seen = new Set(files);

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const rel of files) scanPath(root, rel, out, true);

  // Scan always-probed paths, deduplicating against files already checked
  for (const rel of ALWAYS_PROBE) {
    if (seen.has(rel)) continue;
    scanPath(root, rel, out, false);
  }

  return out;
}
