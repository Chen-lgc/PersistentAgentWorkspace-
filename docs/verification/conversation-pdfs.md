# Conversation PDF references

User PDF uploads are retained in the private attachment store. Each user message
persists `pdfReferences` (attachment basename, display name, byte size) in the
message database. Before an OpenAI-compatible turn, QBot collects references
from the active conversation branch up to the triggering user message and
deduplicates them. Ordinary context compaction does not remove references;
Start fresh and switching to a branch without the upload exclude them. Other
conversations never inherit them automatically. An explicitly configured
[shared file workspace](shared-file-workspace.md) additionally lets a member
reference a shared PDF by its unique filename or upload reference in its own
conversation; the shared scope is checked again on every turn. Existing messages are migrated from their
owned upload tags on the next API turn.

The existing API adapter sends saved PDF bytes and the selected history to the
selected model on every turn that can accept them. Kimi's official API uses the
file extraction route described below. Qianfan OCR is not used, and no other
chat model is selected to parse documents. PDF capability is independent of image input.
Explicit `/models` PDF metadata is used when present; otherwise the adapter
tries the actual PDF. A file schema refusal can try the same model through
Responses. An explicit PDF rejection removes file parts and supplies attachment
identifiers and task-delegation instructions to the same model, with a notice,
before any answer or tool execution. The model is told to assign the actual
user task and original reference to the responsible specialist, and that
summaries are not the original document. Credentials, size limits, corrupt
files, timeouts and unrelated provider errors remain errors.
An error listing only `text`, `image_url` and `video_url` as allowed message
content is treated as a PDF rejection only when its message index identifies
a message actually carrying a PDF. Errors pointing at other messages remain
visible.
An explicit invalid or unsupported part type of `file` or `input_file` also
triggers the history-only retry when the outgoing request contains a PDF;
the same wording about other part types does not.

Observed capability is cached for 24 hours by endpoint, credential hash and
model in `pdf-capabilities/` under the workspace data directory. Raw keys and
PDF bytes are not stored in that cache. A changed endpoint/key or expiry causes
capability to be checked again. A successful response establishes transport
acceptance, not the quality of the provider's document interpretation. Unknown
error formats remain visible rather than silently discarding the PDF.

The native request limit remains `TURN_PDF_MAX_BYTES` (currently 50 MiB total).
The provider may impose lower limits. Known unsupported models receive only
attachment identifiers and delegation guidance, without reading the file bytes
or applying the native send limit. The receiving bot validates and sends the
original through its own supported PDF route. Missing or changed originals produce
an explicit error for models receiving PDFs. Each compatible follow-up resends
the original files, so the provider can charge for them again.

## Kimi official file extraction

For exactly `https://api.moonshot.cn/v1` and `https://api.moonshot.ai/v1`,
the OpenAI-compatible adapter uses Kimi's [documented file Q&A flow](https://platform.kimi.com/docs/guide/use-kimi-api-for-file-based-qa):
multipart `POST /files` with `purpose=file-extract`, then
`GET /files/{id}/content`. Pending extraction statuses are polled through
`GET /files/{id}`. Both the newer `extract_status` and older `status` responses
are accepted. Extracted text is sent as labeled reference data alongside the
history to the user's selected model through the existing chat adapter.
No `file` part or file ID is inserted into the chat messages. A previous native
PDF rejection does not disable this route. Model names alone do not activate
it on a third-party relay.

This supplies extracted text, not original page images. The UI and model are
told this distinction. Empty extraction, provider refusal, local file changes,
and timeouts fail visibly instead of silently answering without the document.
Stop cancels upload/extraction; each file has a three-minute timeout. The
existing 50 MiB aggregate PDF limit also applies here, with an additional
16 MiB total extracted-text bound; no text is silently truncated. The selected
model's own context limit may be lower.

Successful extraction is cached under `kimi-pdf-text/` in the workspace data
directory, keyed by endpoint, credential hash, and PDF content hash. Cached
text files use mode 0600 and contain no raw credentials. Original attachments
must still pass the normal private-store validation before cache use. Follow-up
turns, switching between Kimi models, and application restarts reuse this text.
Only references belonging to the active conversation branch are loaded, and
other providers do not receive this cache. Extraction text is not appended to
the saved conversation history. After extraction (including failure), QBot
attempts to delete only the remote upload it just created; this cleanup has a
three-second timeout and cannot mask the original result. A network failure can
leave that upload in the provider account. Local cache files remain until the
workspace data is removed or the cache is manually cleared.

The isolated verification uses synthetic PDF bytes and a loopback stand-in for
Kimi, remapping only the official API origin inside the fixture and blocking
other external fetches. Exercise these steps via `control-omb`, retaining its
`wait`/`messages` JSON and the fixture log:

1. Add an official Kimi endpoint with synthetic credentials and two models;
   upload a PDF through `/api/files` and ask the first model about it.
2. Assert the multipart upload contains the original bytes, extraction runs,
   the outgoing chat has extracted text without a `file` part, and a reply is
   saved under the selected model.
3. Ask a follow-up without attaching again; assert no second upload.
4. Switch to a relay model that rejects PDF parts; assert the request contains
   delegation instructions and original upload references, without any locally
   extracted PDF text or Kimi extraction cache.
5. Switch back to a different Kimi model, then restart the isolated server in
   the same temporary workspace; both turns must reuse the cached extraction.
6. Switch to a native-PDF relay model; assert original PDF parts are still sent.
   Start a separate conversation and confirm no PDF contents are inherited.
7. Stop the exact fixture children and remove their temporary workspace. These
   checks prove routing and persistence, not live Kimi parsing quality or billing.

## Task delegation after native PDF refusal

QBot does not extract PDF text locally. When the selected interface explicitly
rejects PDF input (including cached or declared refusal), the runtime supplies
filenames and exact `upload:` references plus scoped delegation guidance. The
bot chooses a teammate by the user's requested work and the teammate's duties,
passing the original reference and full requirements. Summary, related-work,
experiment, knowledge-management and tutoring tasks keep their respective scope;
they are not replaced with generic summaries or transcription requests.

The receiving bot reads the original using its own supported native or provider
PDF route, and returns the requested analysis with verifiable citations. The
coordinator reviews the result and identifies the source of the evidence. If no
appropriate teammate can read the PDF, it reports which responsible bot needs a
compatible model rather than inventing content or passing the file in a loop.
This guidance does not itself dispatch work: the existing `coordinate_bots`
workflow performs actual task assignment and returns its receipts.

No local extraction code, worker or parser dependency remains. Previously saved
`pdf-text-v1/` cache files are not read or modified. The existing official Kimi
file service remains part of that provider's supported PDF route; it does not
supply another bot's model with extracted text automatically. Provider credential,
quota and unrelated transport errors remain visible and do not trigger delegation
as though PDF input had been rejected.

`server/delegated-pdfs.e2e.test.ts` exercises a real API-model coordinator against
a loopback provider: declared and observed PDF refusal, five task-specific
recipients, original bytes and report saving, follow-ups, a newly delegated
supplement after an intervening user message, department isolation, restart,
an unreadable recipient and unchanged old extraction caches. Simulated model
answers verify orchestration and request contents, not live-model planning quality.
