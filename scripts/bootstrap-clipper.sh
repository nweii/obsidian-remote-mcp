#!/usr/bin/env bash
# ABOUTME: Ensures web-clipper-headless's upstream bundle (obsidian-clipper/dist/api.mjs) is built
# and patched. Idempotent. Workaround for `bun install` failing inside a hoisted node_modules subtree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIPPER="$ROOT/node_modules/web-clipper-headless"
UPSTREAM="$ROOT/node_modules/obsidian-clipper"
BUNDLE="$UPSTREAM/dist/api.mjs"

if [ ! -d "$CLIPPER" ] || [ ! -d "$UPSTREAM" ]; then
  echo "[bootstrap-clipper] web-clipper-headless or obsidian-clipper not installed; skipping."
  exit 0
fi

if [ ! -f "$BUNDLE" ]; then
  echo "[bootstrap-clipper] Building obsidian-clipper API bundle in /tmp (bun install fails inside hoisted node_modules)…"
  WORK="$(mktemp -d)"
  cp -r "$UPSTREAM"/. "$WORK/"
  (cd "$WORK" && bun install --silent && bun run build:api)
  mkdir -p "$UPSTREAM/dist"
  cp "$WORK/dist/api.mjs" "$BUNDLE"
  rm -rf "$WORK"
fi

cd "$CLIPPER"
bun run scripts/build-upstream.ts
