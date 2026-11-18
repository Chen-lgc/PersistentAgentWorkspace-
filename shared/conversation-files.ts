export const CONVERSATION_FILE_LIMITS = { fileBytes: 512 * 1024, totalBytes: 20 * 1024 * 1024, files: 100 } as const;

/** A stable reference distinguishes files with the same name in a shared workspace. */
export interface WorkspaceFileSource {
  readName?: string;
  sourceLabel?: string;
}

/** The shared file scope does not grant access to its members' chat history. */
export interface FileWorkspaceScope {
  label: string;
  members: string[];
}

/** Persistent UTF-8 text files, independent of the selected model. */
export interface ConversationFile extends WorkspaceFileSource {
  name: string;
  bytes: number;
  updatedAt: number;
  revision: string;
}

export interface ConversationFileContent extends ConversationFile {
  content: string;
}

/** An original sent attachment, persisted with its conversation and opened by ID even when names collide. */
export interface ConversationUpload extends WorkspaceFileSource {
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
