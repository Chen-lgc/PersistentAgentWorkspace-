# Persistent Agent Workspace · G0 Design Contract

## Authority boundaries

```text
Desktop (Maus Electron; i18n: src/locales/*)
    |
Maus Server + Multi-agent Runtime (existing; do not replace)
    |                             |
    |                       Memory Adapter (new)
    |                         |- Maus native memory (write-authoritative in G0)
    |                         |- memhub local profile read (profile-only output, not data-source ACL; opt-in)
    |                         `- Future project/agent ACL stores (NOT Hub default global recall)
    |
ProjectTask / TaskEpoch / CommitLedger (new, authoritative task version)
    |
TraceRecorder / ToolReceipt / ObservedEffect / Verifier (new, ADE)
    |
OmniFM & other models via existing provider driver; model comparisons in snapshots
```

### Non-negotiable

1. Memory is evidence, never authorization. External text must not bypass tool permission.
2. `task_epoch` is not the same as an Assignment schema version or a memhub storage epoch.
3. A cancelled task may have already made irreversible external effects; observe and account for them.
4. No unverified success label, no cross-project leakage, no fabricated full-duplex or continual-learning claims.
5. Profile/Memory, ProjectTask, Execution Evidence and ADE Training Packs are four different domains.

### Proposed future model-visible manifest

```json
{
  "episode_id": "uuid",
  "task_id": "uuid",
  "task_epoch": 2,
  "decision_id": "uuid",
  "model_id": "provider/model",
  "model_version": "checkpoint-or-api-version",
  "actor_id": "researcher",
  "visible_context_hash": "sha256-of-exact-bytes",
  "visible_context_ref": "immutable-blob-id",
  "available_at": "ISO8601",
  "consumed_at": "ISO8601",
  "proposed_tool_call": null,
  "accepted_tool_call": null,
  "tool_result": null,
  "observed_effect": null,
  "verifier_result": null,
  "commit_ledger_id": null
}
```

The schema is a project proposal, **not implemented in Maus**. Capture timestamps separately, including `capture_timestamp` for media and event timestamp, to prevent future-result leakage. Use append-only event streams and immutable hashes with privacy retention controls.

### Keep / Modify / New Build

- **Keep**: Maus Electron shell, Bot/Thread/Runtime, native Memory and Recall, built-in provider tooling, i18n architecture.
- **Modify/extend carefully**: visible language, Memory read seam, tool event recorder, safe task execution commit gate, model adapters.
- **New Build**: Project Task/Epoch and Compare-and-Swap commits; shared project ACL; independent Verifier; ADE L0/L1/L2 packs; Fair Model Compare Runner.
- **Do not merge**: Norma AGPL source or memhub's untrusted generic REST server into product without audits.
