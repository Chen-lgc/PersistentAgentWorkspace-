# PersistentAgentWorkspace

PersistentAgentWorkspace is a persistent, multilingual AI Agent workspace
developed by Qingyan QLab.

## Project Goals

- Chinese-first, multilingual desktop interaction
- Persistent AI agents and long-running tasks
- Long-term memory and cross-session recall
- Multi-agent task orchestration and recovery
- Future integration with PhysAgentRuntime

## Current Status

**G0 — Initial Engineering Baseline**

This initial version is based on the open-source Maus project.

Completed:
- Independent project repository
- Maus source import and dependency installation
- TypeScript and i18n validation
- Chinese UI coverage analysis
- Preliminary memhub memory adapter and unit tests

Not yet completed:
- Full Chinese localization
- Real memhub integration
- Persistent task recovery extensions
- Desktop end-to-end validation

## Development

Requirements:
- Node.js >= 24
- pnpm 10.33.0

Install dependencies:

    pnpm install --frozen-lockfile

Run checks:

    pnpm typecheck
    pnpm i18n:check
    node scripts/pa-locale-gate.mjs --report-only

## Upstream Attribution

Based on OpenMausBot:
https://github.com/milind-soni/OpenMausBot

Pinned upstream commit:
7776162947298b73a9390fc2b75fdd24cb9087c4

Original upstream README:
docs/upstream/MAUS_README.md

Upstream license and third-party notices are preserved.

## Repository

Qingyan QLab
https://github.com/Qingyan-QLab/PersistentAgentWorkspace

## Notes

This is an engineering baseline, not a production release.
The upstream test suite has known failures in the imported snapshot.
