import { createServer } from "node:http";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("shares files and original uploads through HTTP and real bot tools without opening other departments or private history", async () => {
  const received: any[] = [];
  const provider = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-pdf-model" }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "PDF fixture readout" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("missing fixture port");
  const runtime = await launchRestartableServer({ scripted: true });
  const session = { info: runtime, close: () => runtime.close() };
  const evidence: unknown[] = [];
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(session.info.url + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json();
    evidence.push({ path, method, status: response.status, value });
    return { status: response.status, value };
  };
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "QBot")).bot;
    const summary = (await cli("new-bot", "--name", "Paper Summary", "--section", "Research")).bot;
    const experiment = (await cli("new-bot", "--name", "Experiment", "--section", "Research")).bot;
    const other = (await cli("new-bot", "--name", "Outside", "--section", "Other")).bot;
    const endpoint = (bot: any) => `/api/threads/${bot.activeTaskId}/workspace-files`;
    await call(endpoint(chief), { name: "report.md", content: "QBot original" });
    await call(endpoint(summary), { name: "report.md", content: "Summary original" });
    await call(endpoint(other), { name: "private.md", content: "outside department" });
    const response = await fetch(session.info.url + "/api/files?name=paper.pdf", { method: "POST", headers: { "content-type": "application/pdf" }, body: "%PDF-1.4\nshared original\n%%EOF" });
    expect(response.status).toBe(201);
    const upload: any = await response.json();
    const uploadId = basename(upload.path);
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, unknown> = { [chief.id]: { reply: "Original received" } };
    writeFileSync(planPath, JSON.stringify(plan));
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", `PRIVATE_CHAT_MARKER\n\n<attached-file path="${upload.path}" name="paper.pdf" />`);
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    evidence.push({ chiefMessages: (await call(`/api/threads/${chief.activeTaskId}/messages`)).value, upload });
    expect((await call("/api/config", { fileWorkspaceSharing: { enabled: true, department: "Research", botIds: [chief.id] } }, "PATCH")).status).toBe(200);
    const listing = (await call(endpoint(experiment))).value;
    expect(listing.scope.members).toEqual(expect.arrayContaining(["QBot", "Paper Summary", "Experiment"]));
    expect(listing.files).toHaveLength(2);
    expect(listing.uploads).toEqual([expect.objectContaining({ id: uploadId, sourceLabel: "QBot" })]);
    const fromChief = listing.files.find((file: any) => file.sourceLabel === "QBot");
    const created = await call(endpoint(experiment), { name: "analysis.md", content: "analysis v1" });
    expect(created.status).toBe(200);
    const listedChief = (await call(endpoint(chief))).value;
    expect(listedChief.files).toContainEqual(expect.objectContaining({ name: "analysis.md" }));
    expect((await call(endpoint(summary), { name: created.value.readName, content: "analysis v2", revision: created.value.revision })).status).toBe(200);
    expect((await call(endpoint(chief), { name: created.value.readName, content: "stale", revision: created.value.revision })).status).toBe(409);
    const raw = await fetch(session.info.url + endpoint(experiment) + `?upload=${uploadId}&download=1`);
    expect(raw.status).toBe(200); expect(await raw.text()).toBe("%PDF-1.4\nshared original\n%%EOF");
    expect((await call(endpoint(other))).value.files.map((file: any) => file.name)).toEqual(["private.md"]);
    expect((await call(endpoint(other) + `?upload=${uploadId}`)).status).toBe(404);
    expect((await call(endpoint(experiment) + `?name=${encodeURIComponent(`shared:${other.activeTaskId}:private.md`)}`)).status).toBe(404);
    plan[experiment.id] = { steps: [
      { tool: "workspace_file", arguments: { action: "list" } },
      { tool: "workspace_file", arguments: { action: "read", name: fromChief.readName } },
      { tool: "workspace_file", arguments: { action: "write", name: "tool-report.md", content: "Created through the model tool" } },
      { tool: "session_search", arguments: { query: "PRIVATE_CHAT_MARKER", scope: "conversations" } },
    ], reply: "Shared files read and report saved" };
    writeFileSync(planPath, JSON.stringify(plan));
    await cli("send", "--bot", experiment.id, "--task", experiment.activeTaskId, "--text", "Read the shared report and save your analysis.");
    const settled = await cli("wait", "--bot", experiment.id, "--task", experiment.activeTaskId, "--timeout", "30");
    evidence.push({ settled }); expect(settled.status).toBe("settled");
    expect((await call(endpoint(summary))).value.files).toContainEqual(expect.objectContaining({ name: "tool-report.md" }));
    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const turn = turns.find((entry: any) => entry.botId === experiment.id);
    const searches = turn.evidence.filter((entry: any) => entry.step?.tool === "session_search");
    expect(searches).toHaveLength(1);
    expect(JSON.stringify(searches[0].response)).not.toContain("Original received");
    expect(JSON.stringify(searches[0].response)).not.toContain(chief.activeTaskId);
    evidence.push({ tools: turn.evidence });
    expect((await call("/api/config", { openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: "fixture-only-key" }, instances: { openaiCompat: { driver: "openai-compat" } } }, "PUT")).status).toBe(200);
    expect((await call(`/api/bots/${experiment.id}/tasks/${experiment.activeTaskId}`, { modelSelection: { instanceId: "openaiCompat", model: "fixture-pdf-model" } }, "PATCH")).status).toBe(200);
    await cli("send", "--bot", experiment.id, "--task", experiment.activeTaskId, "--text", `Analyze upload:${uploadId}`);
    expect((await cli("wait", "--bot", experiment.id, "--task", experiment.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const pdfParts = (request: any) => request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "file") : []);
    expect(pdfParts(received.at(-1))).toEqual([expect.objectContaining({ file: { filename: "paper.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nshared original\n%%EOF").toString("base64")}` } })]);
    await cli("send", "--bot", experiment.id, "--task", experiment.activeTaskId, "--text", "Explain the method further");
    expect((await cli("wait", "--bot", experiment.id, "--task", experiment.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect(pdfParts(received.at(-1))).toHaveLength(1);
    expect((await call(`/api/bots/${other.id}/tasks/${other.activeTaskId}`, { modelSelection: { instanceId: "openaiCompat", model: "fixture-pdf-model" } }, "PATCH")).status).toBe(200);
    await cli("send", "--bot", other.id, "--task", other.activeTaskId, "--text", `Analyze upload:${uploadId}`);
    expect((await cli("wait", "--bot", other.id, "--task", other.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect(pdfParts(received.at(-1))).toEqual([]);
    expect((await call("/api/sidebar-sections?section=Research", { name: "Renamed Research" }, "PATCH")).status).toBe(200);
    const renamed = (await call(endpoint(chief))).value;
    expect(renamed.scope.label).toBe("Renamed Research");
    expect(renamed.files).toContainEqual(expect.objectContaining({ name: "tool-report.md" }));
    await runtime.stop(); await runtime.start();
    const afterRestart = (await call(endpoint(summary))).value;
    expect(afterRestart.scope.label).toBe("Renamed Research");
    expect(afterRestart.files).toContainEqual(expect.objectContaining({ name: "tool-report.md" }));
    expect(afterRestart.uploads).toContainEqual(expect.objectContaining({ id: uploadId }));
    evidence.push({ sharedPdfRequests: received.map(request => ({ model: request.model, pdfs: pdfParts(request).map((part: any) => part.file.filename) })) });
  } finally {
    const dir = join(tmpdir(), "openmausbot-verification-evidence"); mkdirSync(dir, { recursive: true });
    const path = join(dir, `shared-file-workspace-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ logPath: session.info.logPath, evidence }, null, 2));
    console.log(`Shared-file workflow evidence: ${path}`);
    await session.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 120_000);
