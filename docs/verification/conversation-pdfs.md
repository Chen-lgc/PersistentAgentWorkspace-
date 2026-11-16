# Conversation PDF references

User PDF uploads are retained in the private attachment store. Each user message
persists `pdfReferences` (attachment basename, display name, byte size) in the
message database. Before an OpenAI-compatible turn, QBot collects references
from the active conversation branch up to the triggering user message and
deduplicates them. Ordinary context compaction does not remove references;
Start fresh and switching to a branch without the upload exclude them. Other
conversations never inherit them. Existing messages are migrated from their
owned upload tags on the next API turn.

The existing API adapter sends saved PDF bytes and the selected history to the
selected model on every turn that can accept them. It does not use OCR or a
second model to parse documents. PDF capability is independent of image input.
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

