// scripts/lib/log-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): the
// repositories, sessions and CLI runner the `log` suites share. Importing it
// points KH_DATA_DIR at a temporary directory for the whole test process, so
// nothing reads or writes the real `~/.claude`; every directory it makes is
// removed after the file's tests.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { appendEvent, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import { SEAL_IDLE_MS, sealClosedSessions } from '../../assets/scripts/harness-seal.mjs';

const LOG = resolve(import.meta.dirname, '..', 'log.mjs');

const made = [];
export const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export const DATA_ROOT = tempDir('hk-log-data-');
process.env.KH_DATA_DIR = DATA_ROOT;

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

/** A project root that is its own repository, so the key never depends on
 * what lies above the temp directory. */
export function project() {
  const d = tempDir('hk-log-repo-');
  mkdirSync(join(d, '.git'));
  return d;
}

export const runLog = (...args) => spawnSync(process.execPath, [LOG, ...args], { encoding: 'utf8', env: { ...process.env, KH_DATA_DIR: DATA_ROOT } });

export const sessionFile = (root, id) => join(repoDataDir(root), 'sessions', sessionFileName(id));
export const sealedFile = (root, id) => `${sessionFile(root, id)}.gz`;

export const touchAgo = (path, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
};

// Built at runtime so no fixture is a literal a reader could mistake for
// real content.
export const CANARY = ['kh', 'canary', 'do-not-print', '7f3a'].join('-');

/** A session of a prompt and two tool calls, one failed, every content field
 * holding the canary. */
export function writeSession(root, id) {
  for (const event of [
    { type: 'SessionStart', session_id: id, source: 'startup' },
    { type: 'UserPromptSubmit', session_id: id, prompt: `please ${CANARY}` },
    { type: 'PostToolUse', session_id: id, tool: 'Bash', inputHash: 'a'.repeat(64), status: 'ok', input: { command: `echo ${CANARY}` }, output: CANARY },
    { type: 'PostToolUseFailure', session_id: id, tool: 'Bash', inputHash: 'b'.repeat(64), status: 'error', firstErrorLine: `Error: ${CANARY}`, input: { command: CANARY }, output: `Error: ${CANARY}` },
  ]) {
    assert.equal(appendEvent(root, id, event).written, true);
  }
}

/** Puts a blob holding `text` in the blob store, named as the hook names
 * one, with no event referencing it; returns its `{ sha256 }`. */
export function writeBlob(root, text) {
  const data = Buffer.from(text, 'utf8');
  const sha256 = createHash('sha256').update(data).digest('hex');
  mkdirSync(join(repoDataDir(root), 'blobs'), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'blobs', `${sha256}.gz`), gzipSync(data));
  return { sha256 };
}

/** Seals every session as if they had all been idle past the threshold. */
export const sealAll = root => sealClosedSessions(root, { now: Date.now() + SEAL_IDLE_MS + MINUTE_MS });

/** Every file under `dir`, by relative path, with its bytes. */
export function snapshot(dir) {
  const files = {};
  const walk = rel => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files[path] = readFileSync(join(dir, path)).toString('base64');
    }
  };
  walk('');
  return files;
}

/** Every entry under `dir` by relative path: a file with its bytes, a
 * directory (empty or not) as `{ dir: true }`, and any other entry as
 * `{ other: true }`, so a new empty directory and a changed file both show. */
export function treeSnapshot(dir) {
  const entries = {};
  const walk = rel => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        entries[path] = { dir: true };
        walk(path);
      } else if (entry.isFile()) {
        entries[path] = readFileSync(join(dir, path)).toString('base64');
      } else {
        entries[path] = { other: true };
      }
    }
  };
  walk('');
  return entries;
}

export const statusJson = root => {
  const r = runLog(root, 'status', '--json');
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
