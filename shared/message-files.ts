export interface MessageFileFields {
  /** User-uploaded PDF references owned by this message. IDs are private attachment-store basenames, never paths
   * or provider file IDs. Replayed from the active conversation branch independently of text compaction. */
  pdfReferences?: Array<{ id: string; name: string; bytes: number }>;
  /** Successfully saved workspace file names from this turn, opened only in this message's conversation. */
  workspaceFiles?: string[];
}
