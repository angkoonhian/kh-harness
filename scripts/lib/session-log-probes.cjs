// scripts/lib/session-log-probes.cjs
//
// A `--require` preload for session-log.test.mjs, not a suite. Each probe is
// on only when its variable is set.
//
// KH_PAYLOAD_PROBE: a hook payload parsed from stdin (an object carrying
// `hook_event_name`) is handed back behind a proxy that appends the name of
// every property read to that file.
//
// KH_FAIL_APPEND_MATCHING: `fs.appendFileSync` throws EIO for data that
// contains this text, so one chosen line fails to write.
'use strict';
const fs = require('node:fs');

const probe = process.env.KH_PAYLOAD_PROBE;
if (probe) {
  const parse = JSON.parse;
  JSON.parse = function probedParse(...args) {
    const value = parse.apply(this, args);
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'hook_event_name')) return value;
    return new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'string') fs.appendFileSync(probe, `${key}\n`);
        return Reflect.get(target, key, receiver);
      },
    });
  };
}

const failMatching = process.env.KH_FAIL_APPEND_MATCHING;
if (failMatching) {
  const append = fs.appendFileSync;
  fs.appendFileSync = function failingAppend(path, data, ...rest) {
    if (String(data).includes(failMatching)) throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    return append.call(this, path, data, ...rest);
  };
}
