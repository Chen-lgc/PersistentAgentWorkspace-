import { createContext } from "react";

export interface WorkspaceDraft { name: string; content: string }

export const ConversationFilesContext = createContext<{
  threadId: string;
  canWrite: boolean;
  open(draft?: WorkspaceDraft): void;
  openFile(name: string): void;
} | null>(null);
