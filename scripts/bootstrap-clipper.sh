#!/usr/bin/env bash
# ABOUTME: Build the optional clipper using the root project's audited lockfile and dependencies.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$REPO_ROOT/node_modules/web-clipper-headless" ] || [ ! -d "$REPO_ROOT/node_modules/obsidian-clipper" ]; then
  echo "[bootstrap-clipper] Optional clipper is not installed; skipping."
  exit 0
fi

cd "$REPO_ROOT"
exec bun run setup:clipper
