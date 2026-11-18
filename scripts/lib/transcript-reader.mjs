// scripts/lib/transcript-reader.mjs
//
// Reads Claude Code's own session transcript for what no hook can observe:
// a user interrupt. The transcript's location is documented but its line
// format is internal and changes between releases, so a session containing
// any line this reader does not know is reported as not checked rather than
// read by guesswork.
import { closeSync, openSync, readSync } from 'node:fs';

// Every `type` value seen in the transcripts on the development machine on
// 2026-11-19, written by Claude Code 2.1.159 through 2.1.327. Many of these
// lines carry no `version` field, so the list cannot be keyed by version.
export const KNOWN_LINE_TYPES = Object.freeze([
  'agent-name',
  'ai-title',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'assistant',
  'atis-latch',
  'attachment',
  'continued-in',
  'cost-state',
  'file-history-delta',
  'file-history-snapshot',
  'frame-link',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'relocated',
  'session-owner',
  'system',
  'tools-used',
  'user',
  'worktree-state',
]);

const KNOWN = new Set(KNOWN_LINE_TYPES);

// An interrupt is a `user` line whose content is a list holding a text block
// that is exactly one of these, or a string that is one of these once
// trimmed. Only the list form was observed; the string form is accepted
// defensively, because a missed interrupt in a session reported as checked
// is an undercount nobody sees. The same words inside a tool result or a
// longer text are output or quotation, not an interrupt.
const INTERRUPT_MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

// Transcripts reach hundreds of megabytes, so the file is never held whole;
// only the line being assembled is.
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The shape of a `user` line's content when it is neither a string nor a
 * list, or null when it is one of those. */
function unknownContentShape(content) {
  if (typeof content === 'string' || Array.isArray(content)) return null;
  if (content === undefined) return 'missing';
  return content === null ? 'null' : typeof content;
}

const isInterrupt = content =>
  typeof content === 'string'
    ? INTERRUPT_MARKERS.has(content.trim())
    : content.some(block => block?.type === 'text' && INTERRUPT_MARKERS.has(block.text));

/** Calls `onLine(bytes, number)` for each line of the file, numbered from 1,
 * including an unterminated last line, and stops early when it returns
 * false. Throws what the file system throws. */
function forEachLine(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = [];
    let number = 0;
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
      let start = 0;
      for (let nl = chunk.indexOf(NEWLINE, start); nl !== -1 && nl < n; nl = chunk.indexOf(NEWLINE, start)) {
        pending.push(chunk.subarray(start, nl));
        if (onLine(Buffer.concat(pending), ++number) === false) return;
        pending = [];
        start = nl + 1;
      }
      if (start < n) pending.push(Buffer.from(chunk.subarray(start, n)));
    }
    if (pending.length > 0) onLine(Buffer.concat(pending), ++number);
  } finally {
    closeSync(fd);
  }
}

/**
 * What the transcript at `path` shows that hooks cannot: the user interrupts
 * with their timestamps. `claudeCodeVersion` is the version on the last line
 * that carries one, since a resumed session can span an upgrade, or null.
 * The session is `not-checked`, with no interrupts, when the file cannot be
 * read, when a line does not parse as an object with a string `type`, when
 * a `user` line's content is neither a string nor a list, when an interrupt
 * has no timestamp, or when any line's type is not in
 * KNOWN_LINE_TYPES; `unknownLineTypes` lists those types in order of first
 * appearance. Never throws.
 */
export function readTranscript(path) {
  let claudeCodeVersion = null;
  let problem = null;
  const interrupts = [];
  const unknown = new Set();
  try {
    // Reading continues past an unknown type so that every unknown type is
    // named, and stops at any other problem.
    forEachLine(path, (bytes, number) => {
      let line;
      try {
        line = JSON.parse(utf8.decode(bytes));
      } catch {
        problem = `line ${number} does not parse`;
        return false;
      }
      if (!isPlainObject(line) || typeof line.type !== 'string') {
        problem = `line ${number} has no string type`;
        return false;
      }
      if (typeof line.version === 'string') claudeCodeVersion = line.version;
      if (!KNOWN.has(line.type)) {
        unknown.add(line.type);
        return true;
      }
      if (line.type !== 'user') return true;
      const content = line.message?.content;
      const shape = unknownContentShape(content);
      if (shape !== null) {
        problem = `line ${number} is a user line whose content is ${shape}, not a string or a list`;
        return false;
      }
      if (!isInterrupt(content)) return true;
      if (typeof line.timestamp !== 'string') {
        problem = `line ${number} is an interrupt without a timestamp`;
        return false;
      }
      interrupts.push({ ts: line.timestamp });
      return true;
    });
  } catch (error) {
    return { status: 'not-checked', reason: `cannot read the transcript (${error?.code ?? error?.message})`, claudeCodeVersion: null, interrupts: [], unknownLineTypes: [] };
  }
  const unknownLineTypes = [...unknown];
  if (problem === null && unknownLineTypes.length > 0) problem = `unknown line type: ${unknownLineTypes.join(', ')}`;
  if (problem !== null) return { status: 'not-checked', reason: problem, claudeCodeVersion, interrupts: [], unknownLineTypes };
  return { status: 'ok', claudeCodeVersion, interrupts, unknownLineTypes };
}

/** How many of the transcripts at `paths` were checked and how many were
 * not, the interrupts found in the checked ones, and every unknown line type
 * seen, sorted. */
export function summariseTranscripts(paths) {
  const summary = { checked: 0, notChecked: 0, interrupts: 0, unknownLineTypes: [] };
  const unknown = new Set();
  for (const path of paths) {
    const r = readTranscript(path);
    if (r.status === 'ok') {
      summary.checked++;
      summary.interrupts += r.interrupts.length;
    } else {
      summary.notChecked++;
    }
    for (const type of r.unknownLineTypes) unknown.add(type);
  }
  summary.unknownLineTypes = [...unknown].sort();
  return summary;
}
