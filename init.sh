#!/bin/bash
# init.sh - Agent runs this first to orient itself

echo "=== Current Directory ==="
pwd
ls -F

echo "=== Git Status ==="
git status --short

echo "=== Recent Progress ==="
tail -n 10 progress.txt 2>/dev/null || echo "(no progress yet)"

echo "=== Features Status ==="
if command -v jq &>/dev/null && [ -f features.json ]; then
  total=$(jq 'length' features.json)
  passed=$(jq '[.[] | select(.passes == true)] | length' features.json)
  next=$(jq -r '[.[] | select(.passes == false)] | .[0].id // "DONE"' features.json)
  echo "Progress: $passed/$total | Next: $next"
else
  echo "(features.json not found or jq not installed)"
fi

echo "=== Quick Build Check ==="
if [ -f package.json ]; then
  pnpm build --dry-run 2>/dev/null || npm run build --dry-run 2>/dev/null || echo "No build script or build check failed"
elif [ -f Cargo.toml ]; then
  cargo check 2>&1 | tail -3
elif [ -f go.mod ]; then
  go build ./... 2>&1 | tail -3 || echo "Go build OK"
elif [ -f Package.swift ]; then
  swift build --skip-update 2>&1 | tail -3 || echo "Swift build check"
else
  echo "(no recognized build system)"
fi
