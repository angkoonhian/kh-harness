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
// An entry's section is found with the parser's own lines and heading
// pattern (`registryLines`, `ANY_H2`, `RULE_HEADING`), so an id is replaced
// or removed only where `parseRules` reads it, and a change that would alter
// any other entry `parseRules` reads is refused.
//
// Every entry is written `status: active`, the only status the committed
// file holds: a retired learning is removed from the file, not kept in it
// with another status.
//
// A new file starts from `assets/templates/LEARNED.md.tmpl`, rendered with
// the kit's version as `kitVersion`.
import {
  ANY_H2, ENFORCERS, escapeDelimiters, maskText, parseRules, registryLines, RULE_HEADING, stripUnsafe,
} from '../../assets/scripts/harness-redact.mjs';

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
 * control characters removed, every other whitespace character made a
 * plain space, runs of spaces collapsed and the ends trimmed,
 * credential-shaped values masked, then `<` and `>` escaped. The cap counts
 * the escaped text and never cuts inside an escape or a surrogate pair.
 *
 * The mask runs before the escape and the cap. An escape's `;` ends an
 * unquoted keyed value, so `password=<x>` escaped first would mask only
 * `&lt`; and a cap that cut a token first could leave a fragment too short
 * for any shape to recognise.
 */
function cleanLine(raw, max) {
  const plain = maskText(stripUnsafe(raw).replace(/[^\S ]/g, ' ').replace(/ {2,}/g, ' ').trim());
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

const validTimestamp = ts => ts === null || (typeof ts === 'string' && TIMESTAMP.test(ts) && !Number.isNaN(Date.parse(ts)));
const day = ts => ts === null ? null : ts.slice(0, 10);

/** `{ line }`, the evidence key's value in fixed wording built only from the
 * summary's validated values, or `{ field }` naming its first fault. */
function evidenceLine(summary) {
  if (summary === null || typeof summary !== 'object') return { field: 'evidence' };
  const { signature, sessions, firstTs, lastTs, external } = summary;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { field: 'evidence signature' };
  if (!Number.isInteger(sessions) || sessions < 1) return { field: 'evidence sessions' };
  if (!validTimestamp(firstTs)) return { field: 'evidence firstTs' };
  if (!validTimestamp(lastTs)) return { field: 'evidence lastTs' };
  if (firstTs !== null && lastTs !== null && Date.parse(firstTs) > Date.parse(lastTs)) return { field: 'evidence date range' };
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
 * `{ signature, sessions, firstTs, lastTs, external }` with ISO timestamps,
 * in order, or null; `approvedSha256` 64 lowercase hex characters. `title`
 * and `why` are cleaned (see `cleanLine`); either with nothing left is
 * refused.
 */
export function renderLearnedEntry(entry) {
  if (entry === null || typeof entry !== 'object') return refuse('the entry');
  const { id, title, why, enforcedBy, pointer, evidenceSummary, approvedSha256 } = entry;
  if (typeof id !== 'string' || !ID.test(id)) return refuse('id');
  const cleanTitle = typeof title === 'string' ? cleanLine(title, TITLE_MAX) : '';
  if (cleanTitle === '') return refuse('title');
  const cleanWhy = typeof why === 'string' ? cleanLine(why, WHY_MAX) : '';
  if (cleanWhy === '') return refuse('why');
  if (!ENFORCERS.includes(enforcedBy)) return refuse('enforced-by');
  if (typeof pointer !== 'string' || !POINTER.test(pointer) || stripUnsafe(pointer) !== pointer) return refuse('pointer');
  const evidence = evidenceLine(evidenceSummary);
  if (evidence.field) return refuse(evidence.field);
  if (typeof approvedSha256 !== 'string' || !SHA256.test(approvedSha256)) return refuse('approved-sha256');
  return {
    text: [
      `## ${id} — ${cleanTitle}`,
      `- why: ${cleanWhy}`,
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
 * The `[start, end)` offsets in `text` of the section `parseRules` reads as
 * the rule `id`: from its heading's line to the next level-2 heading's line
 * or the end of the text. The first heading with the id wins, as in the
 * parser. `null` when the parser reads no rule `id`.
 */
function sectionOf(text, id) {
  const lines = registryLines(text);
  // Line `i` of `registryLines` is line `i` of `text`; these are their starts.
  const starts = [0, ...[...text.matchAll(/\r?\n/g)].map(m => m.index + m[0].length)];
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    if (!ANY_H2.test(lines[i])) continue;
    if (start !== null) return [start, starts[i]];
    if (RULE_HEADING.exec(lines[i])?.[1] === id) start = starts[i];
  }
  return start === null ? null : [start, text.length];
}

/** The rules `parseRules` reads in `text` other than `id`, without their
 * line numbers, for comparing two texts. */
const othersIn = (text, id) => JSON.stringify(parseRules(text).rules.filter(r => r.id !== id).map(({ line: _line, ...r }) => r));

/** `{ text: after }`, or an error when `after` would read differently from
 * `before` in any rule but `id`, or, when writing, would not read as rule
 * `id` at all. */
function guarded(before, after, id, verb) {
  const writing = verb === 'writing';
  const ok = othersIn(after, id) === othersIn(before, id)
    && (!writing || parseRules(after).rules.some(r => r.id === id));
  return ok
    ? { text: after }
    : { error: `learned entry: ${verb} ${id} would change another entry or not be read back — nothing was ${writing ? 'rendered' : 'removed'}` };
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
    return guarded(text, base + (base === '' ? '' : eol) + section, entry.id, 'writing');
  }
  const [start, end] = at;
  const old = text.slice(start, end);
  const trailing = old.slice(old.replace(/[\r\n \t]+$/, '').length);
  return guarded(text, text.slice(0, start) + section.trimEnd() + (trailing === '' ? eol : trailing) + text.slice(end), entry.id, 'writing');
}

/**
 * `{ text, removed }`: `text` without the section `parseRules` reads as the
 * rule `id`, every other byte unchanged, and `removed: true`; or `text`
 * itself and `removed: false` when the parser reads no rule `id`.
 */
export function removeLearnedEntry(text, id) {
  if (typeof text !== 'string') return { error: 'learned entry: the registry text is not a string — nothing was removed' };
  if (typeof id !== 'string' || !ID.test(id)) return { error: 'learned entry: id is missing or malformed — nothing was removed' };
  const at = sectionOf(text, id);
  if (at === null) return { text, removed: false };
  const result = guarded(text, text.slice(0, at[0]) + text.slice(at[1]), id, 'removing');
  return result.error ? result : { ...result, removed: true };
}
