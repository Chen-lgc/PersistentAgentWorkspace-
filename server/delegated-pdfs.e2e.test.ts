import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { textPdf } from "./testing/pdf-fixture.ts";

it("delegates unreadable PDFs by task without local extraction and delivers originals to the responsible bots", async () => {
  const paper = textPdf(["SOURCE_ONLY_574c: controller A uses feedback.", "2. Experiments: baseline 40, ours 60."]);
  const roles = ["SUMMARY", "RELATED", "EXPERIMENT", "KNOWLEDGE", "TUTOR"];
  const targets = new Map<string, string>();
  const requests: any[] = [];
  const assigned = new Set<string>();
  const saved = new Set<string>();
  const provider = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [
        { id: "qbot-declared", supports_pdf: false }, { id: "qbot-probed" },
        { id: "unreadable-specialist", supports_pdf: false }, { id: "refused-provider" },
        ...roles.map(role => ({ id: `native-${role.toLowerCase()}`, supports_pdf: true })),
      ] })); return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const parts = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "file") : []);
    if (body.model === "refused-provider" || (body.model === "qbot-probed" && parts.length)) {
      res.writeHead(body.model === "refused-provider" ? 401 : 400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: body.model === "refused-provider" ? "Invalid API key" : "PDF input not supported" } })); return;
    }
    const contents = body.messages.map((m: any) => typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "").join("\n");
    const job = [...contents.matchAll(/TASK_([A-Z_]+)/g)].at(-1)?.[1] ?? "NONE";
    const role = job.split("_")[0]!;
    let delta: any;
    const toolCall = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `call-${job}-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    if (body.model.startsWith("qbot-")) {
      if (!assigned.has(job) && targets.has(role) && contents.includes("responsible specialist")) {
        assigned.add(job);
        const references = [...new Set([...contents.matchAll(/upload:[\w-]+\.pdf/g)].map(match => match[0]))];
        delta = toolCall("agents_coordinate_bots", { bot_ids: [targets.get(role)],
          message: `TASK_${job}: complete the requested ${role.toLowerCase()} analysis using ${references.join(" and ")}. Save Markdown and cite PDF pages.`,
          done_when: "Read the original, complete the assigned analysis, and cite evidence.", rework: true });
      } else {
        const report = new RegExp(`REPORT_${job}\\b`).test(contents);
        delta = { content: report ? `完成 TASK_${job}：已收到负责 Bot 的分析，来源为 PDF 第 2 页。` : contents.includes(`BLOCKED_${job}`)
          ? `TASK_${job} 无法完成：负责 Bot 的模型不能读取 PDF，需要配置支持 PDF 的模型。` : `TASK_${job} 已委派，等待结果。` };
      }
    } else if (body.model === "unreadable-specialist") {
      delta = { content: `BLOCKED_${job}: 当前负责 Bot 的模型不支持 PDF，无法核实正文；请配置支持 PDF 的模型。` };
    } else {
      const native = parts.some((p: any) => p.file.file_data === `data:application/pdf;base64,${paper.toString("base64")}`);
      const answer = native ? `# REPORT_${job}\n\n${role} 分析：基线 40，方法 60，相对提升 50%。来源：paper.pdf，PDF 第 2 页。` : "No source available";
      const fileTool = body.tools?.some((tool: any) => tool.function?.name === "agents_workspace_file");
      if (native && fileTool && !saved.has(job)) {
        saved.add(job);
        delta = toolCall("agents_workspace_file", { action: "write", name: `${job.toLowerCase()}.md`, content: answer });
      } else delta = { content: answer };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const runtime = await launchRestartableServer();
  const evidence: any[] = [];
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(runtime.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json();
    evidence.push({ path, method, status: response.status, value });
    expect(response.ok, JSON.stringify(value)).toBe(true); return value;
  };
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: runtime.url } }) as Promise<any>;
  const wait = async (botId: string, threadId: string) => {
    const result = await cli("wait", "--bot", botId, "--task", threadId, "--timeout", "40");
    evidence.push({ wait: result }); return result;
  };
  const uploadPdf = async (name: string, data: Buffer) => {
    const response = await fetch(runtime.url + `/api/files?name=${name}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: new Uint8Array(data) });
    expect(response.status).toBe(201); return await response.json() as { path: string };
  };
  try {
    const chief = (await cli("new-bot", "--name", "QBot")).bot;
    const members: Array<{ id: string; activeTaskId: string }> = [];
    for (const role of roles) {
      const member = (await cli("new-bot", "--name", `Paper ${role} Bot`, "--section", "Research")).bot;
      members.push(member); targets.set(role, member.id);
    }
    const outside = (await cli("new-bot", "--name", "Outside", "--section", "Other")).bot;
    await api("/api/config", { openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: "fixture-key" }, instances: { openaiCompat: { driver: "openai-compat" } },
      fileWorkspaceSharing: { enabled: true, department: "Research", botIds: [chief.id] } }, "PATCH");
    await api(`/api/bots/${chief.id}`, { modelSelection: { instanceId: "openaiCompat", model: "qbot-declared" } }, "PATCH");
    for (const [index, member] of members.entries()) await api(`/api/bots/${member.id}`, { title: `${roles[index]} specialist`,
      modelSelection: { instanceId: "openaiCompat", model: `native-${roles[index]!.toLowerCase()}` } }, "PATCH");
    const upload = await uploadPdf("paper.pdf", paper);
    const reference = `upload:${basename(upload.path)}`;
    const cache = join(runtime.dataDir, "pdf-text-v1"); mkdirSync(cache);
    const cachePath = join(cache, `${createHash("sha256").update(paper).digest("hex")}.json`);
    writeFileSync(cachePath, JSON.stringify({ totalPages: 1, pages: [{ page: 1, text: "CACHE_ONLY_57df" }] }));
    const cacheTime = statSync(cachePath).mtimeMs;
    for (const [index, role] of roles.entries()) {
      await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", `TASK_${role}: complete the ${role.toLowerCase()} task and save Markdown with page citations.${index === 0 ? `\n\n<attached-file path="${upload.path}" name="paper.pdf" />` : ""}`);
      expect((await wait(chief.id, chief.activeTaskId)).status).toBe("settled");
    }
    const nodes = readHandoffs(runtime.dataDir).filter(node => node.parentId);
    evidence.push({ nodes }); expect(nodes).toHaveLength(5);
    expect(nodes.every(node => node.status === "completed")).toBe(true);
    for (const [index, role] of roles.entries()) {
      const node = nodes.find(node => node.botId === members[index]!.id)!;
      expect(node.text).toContain(`TASK_${role}`);
      expect(node.text).toContain(reference);
      const transcript = (await api(`/api/threads/${node.threadId}/messages`)).messages;
      expect(transcript.some((m: any) => m.role === "bot" && m.roomRequest?.phase === "request" && m.from?.botId === chief.id)).toBe(true);
      expect(transcript.some((m: any) => m.kind === "text" && m.turnSucceeded === true && m.text?.includes("相对提升 50%"))).toBe(true);
      expect(transcript.some((m: any) => m.tool?.name === "agents_vm_exec")).toBe(false);
    }
    const files = await api(`/api/threads/${chief.activeTaskId}/workspace-files`);
    expect(files.files).toHaveLength(5);
    for (const file of files.files) expect((await api(`/api/threads/${chief.activeTaskId}/workspace-files?name=${encodeURIComponent(file.readName)}`)).content).toContain("PDF 第 2 页");
    const chiefRequests = requests.filter(request => request.model === "qbot-declared");
    expect(chiefRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(chiefRequests)).not.toContain("data:application/pdf");
    expect(JSON.stringify(chiefRequests)).not.toContain("SOURCE_ONLY_574c");
    expect(JSON.stringify(chiefRequests)).toContain(reference);
    expect(JSON.stringify(chiefRequests)).toContain("responsible specialist");
    expect((await api(`/api/threads/${chief.activeTaskId}/messages`)).messages.filter((m: any) => m.text?.startsWith("完成 TASK_") && m.turnSucceeded)).toHaveLength(5);
    const worker = nodes.find(node => node.botId === members[0]!.id)!;
    await cli("send", "--bot", worker.botId, "--task", worker.threadId, "--text", "Explain the improvement further.");
    expect((await wait(worker.botId, worker.threadId)).status).toBe("settled");
    const supplement = textPdf(["Supplement: controller A also passes the held-out test."]);
    const extra = await uploadPdf("supplement.pdf", supplement);
    await api(`/api/bots/${chief.id}/tasks/${chief.activeTaskId}`, { modelSelection: { instanceId: "openaiCompat", model: "qbot-probed" } }, "PATCH");
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", `TASK_SUMMARY_SUPPLEMENT: recheck with this supplement.\n\n<attached-file path="${extra.path}" name="supplement.pdf" />`);
    expect((await wait(chief.id, chief.activeTaskId)).status).toBe("settled");
    const probed = requests.filter(request => request.model === "qbot-probed");
    expect(JSON.stringify(probed[0])).toContain("data:application/pdf");
    expect(JSON.stringify(probed[1])).not.toContain("data:application/pdf");
    expect(JSON.stringify(probed[1])).toContain("responsible specialist");
    const updated = readHandoffs(runtime.dataDir).filter(node => node.parentId && node.botId === worker.botId);
    expect(updated).toHaveLength(2); expect(updated.every(node => node.threadId === worker.threadId && node.status === "completed")).toBe(true);
    expect(JSON.stringify(requests.filter(request => request.model === "native-summary").at(-1))).toContain(`data:application/pdf;base64,${supplement.toString("base64")}`);
    await api(`/api/bots/${outside.id}/tasks/${outside.activeTaskId}`, { modelSelection: { instanceId: "openaiCompat", model: "native-summary" } }, "PATCH");
    await cli("send", "--bot", outside.id, "--task", outside.activeTaskId, "--text", `Read ${reference}`);
    expect((await wait(outside.id, outside.activeTaskId)).status).toBe("settled");
    expect(JSON.stringify(requests.at(-1))).not.toContain("data:application/pdf");
    await runtime.stop(); await runtime.start();
    const afterRestart = requests.length;
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "TASK_RELATED_RESTART: research this paper again.");
    expect((await wait(chief.id, chief.activeTaskId)).status).toBe("settled");
    expect(JSON.stringify(requests.slice(afterRestart).filter(request => request.model === "qbot-probed"))).not.toContain("data:application/pdf");
    expect(JSON.stringify(requests.slice(afterRestart).filter(request => request.model === "native-related"))).toContain("data:application/pdf");
    const blocked = (await cli("new-bot", "--name", "Blocked specialist", "--section", "Research")).bot;
    targets.set("BLOCKED", blocked.id);
    await api(`/api/bots/${blocked.id}`, { modelSelection: { instanceId: "openaiCompat", model: "unreadable-specialist" } }, "PATCH");
    const countBefore = readHandoffs(runtime.dataDir).filter(node => node.parentId).length;
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "TASK_BLOCKED: ask the responsible specialist to read this PDF.");
    expect((await wait(chief.id, chief.activeTaskId)).status).toBe("settled");
    expect(readHandoffs(runtime.dataDir).filter(node => node.parentId)).toHaveLength(countBefore + 1);
    expect((await api(`/api/threads/${chief.activeTaskId}/messages`)).messages.some((m: any) => m.text?.includes("无法完成：负责 Bot 的模型不能读取 PDF"))).toBe(true);
    const refused = (await cli("new-bot", "--name", "Provider refusal", "--section", "Research")).bot;
    await api(`/api/bots/${refused.id}`, { modelSelection: { instanceId: "openaiCompat", model: "refused-provider" } }, "PATCH");
    await cli("send", "--bot", refused.id, "--task", refused.activeTaskId, "--text", `Read ${reference}`);
    expect((await wait(refused.id, refused.activeTaskId)).status).toBe("failed");
    expect(requests.filter(request => request.model === "refused-provider")).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("CACHE_ONLY_57df");
    expect(JSON.stringify(requests)).not.toContain("locally extracted PDF");
    expect(statSync(cachePath).mtimeMs).toBe(cacheTime);
  } finally {
    const dir = join(tmpdir(), "openmausbot-verification-evidence"); mkdirSync(dir, { recursive: true });
    const path = join(dir, `delegated-pdfs-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ logPath: runtime.logPath, evidence, requests }, null, 2));
    console.log(`Delegated PDF evidence: ${path}`);
    await runtime.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 120_000);
