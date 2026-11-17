export const CONVERSATION_FILE_LIMITS = { fileBytes: 512 * 1024, totalBytes: 20 * 1024 * 1024, files: 100 } as const;

/** UTF-8 text files belonging to one conversation, independent of its selected model. */
export interface ConversationFile {
  name: string;
  bytes: number;
  updatedAt: number;
  revision: string;
}

export interface ConversationFileContent extends ConversationFile {
  content: string;
}

/** An original sent attachment, persisted with its conversation and opened by ID even when names collide. */
export interface ConversationUpload {
  source: "upload";
  id: string;
  name: string;
  bytes: number;
  updatedAt: number;
  mime: string;
  available: boolean;
  /** Pass this value as workspace_file's name to read an uploaded text file. */
  readName: string;
}

export interface ConversationUploadContent extends ConversationUpload {
  /** Only present for UTF-8 text within the workspace text preview limit. */
  content?: string;
  contentUnavailable?: string;
}

/** Omitting revision creates a new file; replacing one requires its current content hash. */
export interface ConversationFileWrite {
  name: string;
  content: string;
  revision?: string;
}
