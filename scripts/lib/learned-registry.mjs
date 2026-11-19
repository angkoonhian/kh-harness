// scripts/lib/learned-registry.mjs
//
// The learned registry: `docs/harness/LEARNED.md` (`LEARNED_PATH`), the
// kit-owned file the learning loop's rules go in, in the format `parseRules`
// reads. The owner's `docs/harness/RULES.md` is never written by the kit;
// keeping learned rules in their own file is what lets the kit add and
// remove them without touching a byte the owner wrote.
//
// Every function here maps text to text and touches no file. Each returns
// `{ text }` on success or `{ error }`, a one-line sentence naming the field
// at fault and never its value: a title and a why are drafted by a model
// from session logs, so they are untrusted and are cleaned before they are
// rendered, and anything else malformed is refused. The file is committed,
// so they are credential-masked here, at the mask's own floors, and not
// only when the rules brief injects them.
//
// Every entry is written `status: active`, the only status the committed
// file holds: a retired learning is removed from the file, not kept in it
// with another status.
//
// A new file starts from `assets/templates/LEARNED.md.tmpl`, rendered with
// the kit's version as `kitVersion`.
import { ENFORCERS, escapeDelimiters, maskText, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';

const ID = /^L[1-9][0-9]{0,8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{16}$/;
// `Date.prototype.toISOString`'s shape, which is how the session log
// records `ts`.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// One token with nothing a key line or a delimited block could be split by.
const POINTER = /^[^\s<>]{1,200}$/;
const TITLE_MAX = 120;
const WHY_MAX = 300;

/**
 * Untrusted prose as one line of at most `max` characters: invisible and
 * control characters removed, line breaks and tabs made spaces, the ends
 * trimmed, credential-shaped values masked, then `<` and `>` escaped. The
 * cap counts the escaped text and never cuts inside an escape or a
 * surrogate pair.
 *
 * The mask runs before the escape and the cap. An escape's `;` ends an
 * unquoted keyed value, so `password=<x>` escaped first would mask only
 * `&lt`; and a cap that cut a token first could leave a fragment too short
 * for any shape to recognise.
 */
function cleanLine(raw, max) {
  const plain = maskText(stripUnsafe(raw).replace(/[\r\n\t]/g, ' ').trim());
  let out = '';
  let length = 0;
  for (const ch of plain) {
    const piece = escapeDelimiters(ch);
    if (length + piece.length > max) break;
    out += piece;
    length += piece.length;
  }
  return out.trimEnd();
}

const day = ts => ts === null ? null : ts.slice(0, 10);

/** `{ line }`, the evidence key's value in fixed wording built only from the
 * summary's validated values, or `{ field }` naming its first fault. */
function evidenceLine(summary) {
  if (summary === null || typeof summary !== 'object') return { field: 'evidence' };
  const { signature, sessions, firstTs, lastTs, external } = summary;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { field: 'evidence signature' };
  if (!Number.isInteger(sessions) || sessions < 1) return { field: 'evidence sessions' };
  if (firstTs !== null && (typeof firstTs !== 'string' || !TIMESTAMP.test(firstTs))) return { field: 'evidence firstTs' };
  if (lastTs !== null && (typeof lastTs !== 'string' || !TIMESTAMP.test(lastTs))) return { field: 'evidence lastTs' };
  if (typeof external !== 'boolean') return { field: 'evidence external' };
  const seen = `signature ${signature}, seen in ${sessions} session${sessions === 1 ? '' : 's'}`;
  const range = firstTs === null && lastTs === null
    ? ', dates unknown'
    : ` from ${day(firstTs) ?? 'an unknown date'} to ${day(lastTs) ?? 'an unknown date'}`;
  return { line: seen + range + (external ? ', includes a session flagged for outside content' : '') };
}

const refuse = field => ({ error: `learned entry: ${field} is missing or malformed — nothing was rendered` });

/**
 * One learned entry as a registry section: the `## <id> — <title>` heading
 * and its key lines, ending in a newline. `id` is `L` and a number;
 * `enforcedBy` one of `ENFORCERS`; `pointer` one token; `evidenceSummary`
 * `{ signature, sessions, firstTs, lastTs, external }` with ISO timestamps or
 * null; `approvedSha256` 64 lowercase hex characters. `title` and `why` are
 * cleaned (see `cleanLine`); a title with nothing left is refused.
 */
export function renderLearnedEntry(entry) {
  if (entry === null || typeof entry !== 'object') return refuse('the entry');
  const { id, title, why, enforcedBy, pointer, evidenceSummary, approvedSha256 } = entry;
  if (typeof id !== 'string' || !ID.test(id)) return refuse('id');
  if (typeof title !== 'string') return refuse('title');
  const cleanTitle = cleanLine(title, TITLE_MAX);
  if (cleanTitle === '') return refuse('title');
  if (typeof why !== 'string') return refuse('why');
  if (!ENFORCERS.includes(enforcedBy)) return refuse('enforced-by');
  if (typeof pointer !== 'string' || !POINTER.test(pointer) || stripUnsafe(pointer) !== pointer) return refuse('pointer');
  const evidence = evidenceLine(evidenceSummary);
  if (evidence.field) return refuse(evidence.field);
  if (typeof approvedSha256 !== 'string' || !SHA256.test(approvedSha256)) return refuse('approved-sha256');
  const cleanWhy = cleanLine(why, WHY_MAX);
  return {
    text: [
      `## ${id} — ${cleanTitle}`,
      cleanWhy === '' ? '- why:' : `- why: ${cleanWhy}`,
      `- enforced-by: ${enforcedBy}`,
      `- pointer: ${pointer}`,
      '- origin: learned',
      '- status: active',
      `- evidence: ${evidence.line}`,
      `- approved-sha256: ${approvedSha256}`,
      '',
    ].join('\n'),
  };
}

/**
 * The `[start, end)` offsets of the first section whose heading names `id`:
 * from its `## ` line up to the next `## ` line or the end of the text. A
 * heading inside an HTML comment is not a section, as `parseRules` reads it.
 * `null` when there is none.
 */
function sectionOf(text, id) {
  const visible = text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\r\n]/g, ' '));
  const heading = /^##(?=\s|$)/gm;
  const own = new RegExp(String.raw`^##\s+${id}(?=\s|$)`);
  let start = null;
  for (const m of visible.matchAll(heading)) {
    if (start !== null) return [start, m.index];
    const lineEnd = visible.indexOf('\n', m.index);
    if (own.test(visible.slice(m.index, lineEnd === -1 ? undefined : lineEnd))) start = m.index;
  }
  return start === null ? null : [start, text.length];
}

/**
 * `text` with `entry` (as `renderLearnedEntry` takes it) in place of the
 * section of the same id, or appended after a blank line when there is
 * none. A section's trailing blank lines are kept, and a CRLF file stays
 * CRLF.
 */
export function upsertLearnedEntry(text, entry) {
  if (typeof text !== 'string') return { error: 'learned entry: the registry text is not a string — nothing was rendered' };
  const rendered = renderLearnedEntry(entry);
  if (rendered.error) return rendered;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = rendered.text.replace(/\n/g, eol);
  const at = sectionOf(text, entry.id);
  if (at === null) {
    const base = text === '' || text.endsWith('\n') ? text : text + eol;
    return { text: base + (base === '' ? '' : eol) + section };
  }
  const [start, end] = at;
  const old = text.slice(start, end);
  const trailing = old.slice(old.trimEnd().length);
  return { text: text.slice(0, start) + section.trimEnd() + (trailing === '' ? eol : trailing) + text.slice(end) };
}

/**
 * `{ text, removed }`: `text` without the section whose heading names `id`,
 * every other byte unchanged, and `removed: true`; or `text` itself and
 * `removed: false` when no section names it.
 */
export function removeLearnedEntry(text, id) {
  if (typeof text !== 'string') return { error: 'learned entry: the registry text is not a string — nothing was removed' };
  if (typeof id !== 'string' || !ID.test(id)) return { error: 'learned entry: id is missing or malformed — nothing was removed' };
  const at = sectionOf(text, id);
  if (at === null) return { text, removed: false };
  return { text: text.slice(0, at[0]) + text.slice(at[1]), removed: true };
}
