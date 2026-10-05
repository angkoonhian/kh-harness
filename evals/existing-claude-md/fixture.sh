#!/usr/bin/env bash
# Scaffolds a small existing repository with a hand-written CLAUDE.md that
# already carries a human decision no detector could re-derive. The case
# exists to prove this skill never overwrites it in place.
set -euo pipefail

cat > CLAUDE.md <<'EOF'
# existing-claude-md-fixture

SENTINEL-DO-NOT-REGENERATE: this line was written by a human on this team
and must survive any harness setup completely untouched.

This repository ships a release process that lives only in this file:
tag first, build second, publish last. Nothing else documents this order.
EOF

cat > package.json <<'EOF'
{
  "name": "existing-claude-md-fixture",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
EOF

cat > package-lock.json <<'EOF'
{
  "name": "existing-claude-md-fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {}
}
EOF

mkdir -p src
cat > src/index.mjs <<'EOF'
export function greet(name) {
  return `hello, ${name}`;
}
EOF

git init -q
git config user.email "fixture@example.com"
git config user.name "Fixture"
git checkout -q -b trunk
git add -A
git commit -q -m "initial commit" >/dev/null
