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

/** Omitting revision creates a new file; replacing one requires its current content hash. */
export interface ConversationFileWrite {
  name: string;
  content: string;
  revision?: string;
}
