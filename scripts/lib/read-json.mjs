// scripts/lib/read-json.mjs
//
// The one reader for the JSON files this tool decides from: the two project
// settings files and its own manifest.
import { readFileSync } from 'node:fs';

export const UTF8_BOM = '\uFEFF';

/** `text` without one leading UTF-8 BOM, if it has one. */
export function stripBom(text) {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

/**
 * Reads a JSON file into one of three states, and "present but unusable" is
 * never reported as "absent":
 *
 *   { state: 'absent' }                      — nothing at this path (or a
 *                                              parent is a plain file)
 *   { state: 'unreadable', reason: string }  — present, but could not be
 *                                              read or is not valid JSON
 *   { state: 'ok', value, text }             — `value` is the parsed JSON;
 *                                              `text` is the file exactly as
 *                                              read, BOM included, for a
 *                                              writer that must keep its form
 *
 * One leading UTF-8 BOM is stripped before parsing. `reason` is a predicate
 * phrase ("is not valid JSON") and never quotes the file: JSON.parse's own
 * message carries a slice of the text, and settings files hold credentials.
 * Judging the parsed value's shape is the caller's job.
 */
export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unreadable', reason: `could not be read (${err?.code ?? 'unknown error'})` };
  }
  try {
    return { state: 'ok', value: JSON.parse(stripBom(text)), text };
  } catch {
    return { state: 'unreadable', reason: 'is not valid JSON' };
  }
}
