# Conversation PDF references

## Default paper research reports

`server/paper-report-prompt.ts` defines the conditional report policy. The shared
system-prompt builder includes it as a stable `paper-report` section in direct
and group conversations and in the prompt preview. It is independent of the
selected provider and whether tools are enabled. The model applies the policy
to broad requests to analyze, explain or summarize a paper, including the first
PDF upload with “为我分析这篇论文” or “为我总结论文内容” and follow-ups about
an earlier upload. “Summarize” alone does not mean a brief answer. Only an
explicit request for brevity or a limited task overrides that default; uploading
a file alone, translating an abstract, narrow questions and unrelated chat do
not request a full report.

The default report covers bibliographic information and research questions,
the overall approach and contributions, method details, experiments and
results, novelty and limitations, critical analysis, and practical value.
Additional requirements supplement these areas; explicit scope, language,
format and length instructions take precedence. The report defaults to Chinese
with Markdown headings and substantive analysis even in conversational mode.
Theory papers and surveys use the applicable equivalents rather than invented
training procedures or benchmarks. The same completeness rules apply to a
saved report, with a pre-delivery check for the user's additional requirements.

Every important technical conclusion must cite a verified section number/title
or page near the claim, optionally adding table, figure or equation identifiers.
Printed pages and PDF page positions must be distinguished when different;
extraction order must not be used to guess page numbers. Unverifiable content
or locations must be marked explicitly rather than fabricated. The saved
Markdown report has the same citation requirements as the chat report.
The policy separates reported facts, inferences, estimates and unavailable
evidence. Attachment metadata is not paper content, missing extraction is not
proof of omission in the paper, and
history-only or text-extraction notices still limit what the model can claim.
The policy does not supply new PDF-reading or document-generation capabilities.

Verify with a disposable server and loopback model: inspect the actual system
prompt for the seven areas and the scope/evidence rules; first upload a PDF with
each broad analysis/summary request and with explicit brief/narrow requests;
then send a follow-up report request without reattaching it; preserve additional requests
for emphasis, restricted scope, language and length in the outgoing turn.
Exercise a tool save and check the report bytes and message file link. Repeat
in a group and with a model that rejects PDF parts, checking the existing
history-only retry and notice. Also inspect a CLI engine's captured system
prompt and the prompt preview. These checks establish instruction delivery,
PDF routing and persistence; scripted replies cannot establish whether a real
model follows the policy or produces a sound analysis of a real paper.

## PDF retention and transport

User PDF uploads are retained in the private attachment store. Each user message
persists `pdfReferences` (attachment basename, display name, byte size) in the
message database. Before an OpenAI-compatible turn, QBot collects references
from the active conversation branch up to the triggering user message and
deduplicates them. Ordinary context compaction does not remove references;
Start fresh and switching to a branch without the upload exclude them. Other
conversations never inherit them. Existing messages are migrated from their
owned upload tags on the next API turn.

The existing API adapter sends saved PDF bytes and the selected history to the
selected model on every turn that can accept them. Kimi's official API uses the
file extraction route described below. Qianfan OCR is not used, and no other
chat model is selected to parse documents. PDF capability is independent of image input.
Explicit `/models` PDF metadata is used when present; otherwise the adapter
tries the actual PDF. A file schema refusal can try the same model through
Responses. An explicit PDF rejection falls back to the same model with history
text and a notice, before any answer or tool execution. The model is told that
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
The provider may impose lower limits. Known unsupported models do not read the
saved file bytes or apply this send limit. Missing or changed originals produce
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
4. Switch to a relay model that rejects PDF parts; assert history-only fallback
   contains the Kimi summary but no cached extraction text.
5. Switch back to a different Kimi model, then restart the isolated server in
   the same temporary workspace; both turns must reuse the cached extraction.
6. Switch to a native-PDF relay model; assert original PDF parts are still sent.
   Start a separate conversation and confirm no PDF contents are inherited.
7. Stop the exact fixture children and remove their temporary workspace. These
   checks prove routing and persistence, not live Kimi parsing quality or billing.
