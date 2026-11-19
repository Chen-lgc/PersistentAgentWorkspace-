# Persistent Agent Workspace — Private G0 Snapshot

This private repository was initialized from **QBot open-source current working tree**, pinned to the SHA in `UPSTREAM_LOCK.json`. It is a development-stage integration, not yet a rebranded distributable product.

## First-release requirements

- Chinese-first workflows with English and other languages available.
- Persistent conversations and memory across restarts.
- No cross-agent/project confidential-memory leaks.
- Task/version tracking, safe user interruption, and independently observed execution events.
- Use memhub as a separate *read-only personal profile* service initially; its standard Hub recall is not a project access-control boundary.

See `docs/PA_ARCHITECTURE.md` and `scripts/pa-locale-gate.mjs`. Do not publish or redistribute until all licensing and brand assets have been reviewed. Keep the upstream `LICENSE`, `NOTICE`, `third_party/`, and attribution intact. Norma is an architecture reference only.
