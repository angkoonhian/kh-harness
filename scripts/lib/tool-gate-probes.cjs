// scripts/lib/tool-gate-probes.cjs
//
// A `--require` preload for tool-gate.test.mjs, not a suite. With
// KH_THROW_HOMEDIR set, `os.homedir` throws, as it can for an account with no
// resolvable home directory, so finding this machine's data directory fails.
'use strict';
const os = require('node:os');

if (process.env.KH_THROW_HOMEDIR) {
  os.homedir = () => {
    throw new Error('injected: no home directory');
  };
}
