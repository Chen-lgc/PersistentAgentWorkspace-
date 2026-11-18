# Shared paper file workspace

On a local single-owner installation, `fileWorkspaceSharing` opts one department
and explicit additional bot IDs into a shared file workspace. For example:

```json
{
  "fileWorkspaceSharing": {
    "enabled": true,
    "department": "论文研究",
    "botIds": ["the-existing-qbot-id"]
  }
}
```

Save with `PATCH /api/config`. The server validates the department and stores its
stable `departmentKey`, so a department rename keeps the same files. New bots
in that department join automatically; moving a bot out revokes access unless
its ID was explicitly included. This sharing does not operate on multi-user or
hosted workspaces. Other departments and group conversations retain their
existing conversation-scoped file workspaces.

The File workspace dialog and the `workspace_file` tool show the shared scope,
member names, generated files, and original uploads from member conversations.
Existing files stay at their original locations, with distinct `readName`
references and source labels. Duplicate filenames are never merged or silently
overwritten. New generated files go into one shared store; deleting their
author's conversation does not delete that shared store. Existing per-source
file limits and revision checks apply. Uploaded originals remain read-only.
Old files and uploads remain tied to their original conversations' lifetime.

Sharing files does not share conversation transcripts or change `session_search`.
A shared PDF is supplied to an OpenAI-compatible model only when the current
conversation's active branch contains a user message or a server-recorded
assignment from a current shared member naming its unique filename or exact
upload reference. Ordinary bot replies and returned results do not select PDFs.
Delegated briefs should include that reference. The assignment's own request
message bounds selection even when the recipient has older user messages. Ambiguous
filenames require the upload reference. Follow-ups retain these references;
Start fresh excludes earlier ones. Every request rechecks the shared scope,
and existing PDF limits and Kimi extraction remain in force. Explicit native
PDF refusals provide only attachment identifiers and task-delegation guidance:
the responsible specialist receives the actual task and original reference,
and reads through its own supported PDF route. QBot performs no local text
extraction. Unreadable recipients report the limitation without inventing content. A list entry or metadata-only workspace read is not PDF content.

Run:

```sh
pnpm exec vitest run server/shared-file-workspace.test.ts src/lib/shared-file-workspace.dom.test.ts server/shared-file-workspace.e2e.test.ts
```

The end-to-end test launches the same isolated fake-engine environment as
`control:omb`, uses its `new-bot`, `send` and `wait` commands, and drives real
workspace HTTP and MCP operations. A loopback model captures the actual PDF
request. It checks historical same-name files, shared creation and updates,
stale revisions, original downloads, other-department refusals, private-history
exclusion, explicit PDF selection and follow-ups, department rename and restart.
The final JSON evidence and server log are kept under the temporary directory's
`openmausbot-verification-evidence`; the fixture home and processes are removed.
The DOM test exercises the real dialog's shared labels and duplicate-file edit
routing. It does not qualify native Electron window layout or live PDF parsing.

`server/delegated-pdfs.e2e.test.ts` drives `coordinate_bots` from an API-model
QBot that cannot read PDFs to five responsible specialist bots. The loopback
provider checks refusal handling, metadata-only coordination, actual original
PDF bytes at each recipient, and real `workspace_file` report saves. It checks
returned results, intervening user messages, new attachments during rework,
outside-department exclusion, restart, unreadable recipients, and absence of
local extraction or old cache use. Synthetic PDF content and simulated model
answers prove transport and workflow, not a live provider's analysis quality.

```sh
pnpm exec vitest run server/delegated-pdfs.e2e.test.ts
```
