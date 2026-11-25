// scripts/lib/half-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): calls
// a hook script's exported half in a child process of its own, as an entry
// script would import it, and returns the half's result.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Standard input is read only after the import has finished, so a module
// that read it or exited while being imported fails the assertions below.
const PROGRAM = `
const [url, name] = process.argv.slice(1);
const mod = await import(url);
let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const result = await mod[name](JSON.parse(text));
process.stdout.write(JSON.stringify(result ?? null));
`;

/** What `exportName` of `script` returns for `payload`, with the project at
 * `root`: a half result, or null. */
export function runHalf(script, exportName, root, payload) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROGRAM, pathToFileURL(script).href, exportName], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.status, 0, `${exportName} exit status; stderr: ${result.stderr}`);
  assert.equal(result.stderr, '', `${exportName} stderr`);
  return JSON.parse(result.stdout);
}
