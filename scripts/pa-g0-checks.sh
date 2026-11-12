#!/usr/bin/env bash
# Run after `pnpm install --frozen-lockfile` in the product root (Node >=24).
set -euo pipefail
node --version
pnpm --version
pnpm i18n:check
node scripts/pa-locale-gate.mjs
pnpm typecheck
pnpm exec vitest run \
  server/runtime/runtime.test.ts \
  server/runtime/store.test.ts \
  server/runtime/scenarios.test.ts \
  server/cjk-search.test.ts \
  server/language.test.ts \
  server/recall.test.ts \
  server/memory-upkeep.test.ts \
  server/memory-store.test.ts \
  server/request-auth.test.ts
node --test extensions/memory/memhub-loopback.test.mjs
