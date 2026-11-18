// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api, ApiError: Error }));
vi.mock("@/lib/i18n", () => ({ t: (key: string, params?: { department?: string }) => `${key}${params?.department ? ` ${params.department}` : ""}` }));
vi.mock("@/components/ChatMarkdown", () => ({ ChatMarkdown: ({ text }: { text: string }) => createElement("div", null, text) }));
vi.mock("@/components/CodeBlock", () => ({ CodeBlock: ({ code }: { code: string }) => createElement("div", null, code) }));
const { ConversationFilesProvider, ConversationFilesButton } = await import("@/components/ConversationFiles");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; api.mockReset(); });

it("shows the shared scope and uses the selected source reference when duplicate names are edited", async () => {
  const files = ["QBot", "Summary"].map((source, index) => ({ name: "report.md", readName: `shared:thread-${index}:report.md`, sourceLabel: source, bytes: 4, updatedAt: 1, revision: `revision-${index}` }));
  api.mockImplementation(async (path: string, options?: { body: string }) => {
    if (options) { const body = JSON.parse(options.body); return { ...files[1], content: body.content }; }
    if (path.includes("?name=")) return { ...files[1], content: "summary content" };
    return { files, uploads: [], scope: { label: "论文研究", members: ["QBot", "Summary"] } };
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(ConversationFilesProvider, { threadId: "current", canWrite: true, children: createElement(ConversationFilesButton) })));
  const click = async (predicate: (button: HTMLButtonElement) => boolean) => {
    const button = Array.from(document.querySelectorAll("button")).find(predicate);
    expect(button).toBeTruthy(); await act(async () => button!.click());
  };
  await click(button => button.getAttribute("aria-label") === "workspaceFiles.title");
  expect(document.body.textContent).toContain("workspaceFiles.sharedDescription 论文研究");
  expect(document.body.textContent).toContain("QBot · Summary");
  await click(button => Boolean(button.textContent?.includes("report.md") && button.textContent.includes("Summary")));
  expect(api).toHaveBeenCalledWith("/api/threads/current/workspace-files?name=shared%3Athread-1%3Areport.md");
  expect(document.body.textContent).toContain("summary content");
  await click(button => button.textContent === "workspaceFiles.edit");
  await click(button => button.textContent === "workspaceFiles.save");
  const write = api.mock.calls.find(([, options]) => options?.method === "POST");
  expect(JSON.parse(write![1].body)).toEqual({ name: files[1]!.readName, content: "summary content", revision: "revision-1" });
  expect(document.body.textContent).toContain("workspaceFiles.sharedSaved");
});
