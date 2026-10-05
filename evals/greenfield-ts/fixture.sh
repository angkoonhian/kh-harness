#!/usr/bin/env bash
# A minimal, real brand-new TypeScript project: just enough that detection has
# something to read, and nothing a human would have hand-tuned yet — no
# CLAUDE.md, no CI, no lint config. That absence is the point of this case.
set -euo pipefail

cat > package.json <<'EOF'
{
  "name": "greenfield-ts-fixture",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "node --test"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
EOF

cat > package-lock.json <<'EOF'
{
  "name": "greenfield-ts-fixture",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {}
}
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
EOF

mkdir -p src
cat > src/index.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF

git init -q
git config user.email "fixture@example.com"
git config user.name "Fixture"
git checkout -q -b trunk
git add -A
git commit -q -m "initial commit" >/dev/null
