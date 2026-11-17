import { ATTACHMENTS_DIR } from "../attachments.ts";
import { messageAttachmentName, messageFileRoots } from "../message-file.ts";
import type { Store } from "../store.ts";
import { workspaceDir } from "../workspace.ts";

export function attachmentNameInThread(store: Store, threadId: string, path: string): string | null {
  const messages = store.messagesFor(threadId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]!.text;
    const name = text ? messageAttachmentName(text, path) : null;
    if (name) return name;
  }
  return null;
}

export function messageFileRootsForThread(store: Store, senderId: string, threadId: string): string[] {
  const directBot = store.botByThread(threadId);
  const group = directBot ? undefined : store.groupByThread(threadId);
  let pinnedCwd: string | null | undefined;
  let configuredCwd: string | undefined;
  if (directBot) {
    pinnedCwd = store.taskByThread(directBot.id, threadId)?.cwd;
    configuredCwd = directBot.cwd;
  } else if (group) {
    const task = store.groupTaskByThread(group.id, threadId);
    pinnedCwd = task ? task.pinnedCwd : group.threadId === threadId ? group.pinnedCwd : undefined;
    configuredCwd = group.cwd;
  }
  return messageFileRoots({
    senderWorkspace: workspaceDir(senderId),
    attachments: ATTACHMENTS_DIR,
    pinnedCwd,
    configuredCwd,
  });
}
