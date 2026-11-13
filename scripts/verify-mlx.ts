import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeCsgHub } from "../server/testing/fake-csghub.ts";
import type { MlxStatus } from "../shared/mlx.ts";

const realModel = process.env.OMB_MLX_MODEL;
const realPython = process.env.OMB_MLX_PYTHON;
assert.equal(Boolean(realModel), Boolean(realPython), "Set both OMB_MLX_MODEL and OMB_MLX_PYTHON for a real offline model check.");
const hub = await startFakeCsgHub(realModel);
const fixture = await launchVerificationServer();
const evidence: unknown[] = [{ fixture: fixture.info, realModel: realModel ?? null, liveCsgHub: false }];
const output = process.env.OMB_UI_EVIDENCE_DIR || join(dirname(fixture.info.logPath), `mlx-${Date.now()}`);
mkdirSync(output, { recursive: true });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
const api = fixtureApi(fixture.info.url);
const status = async () => await api("GET", "/api/mlx") as MlxStatus;
const control = async (args: string[]) => {
  const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
  evidence.push({ command: args, result }); return result;
};
try {
  const fakePython = join(fixture.info.dataDir, "fixture-python");
  copyFileSync(resolve("server/testing/fake-mlx-python.mjs"), fakePython); chmodSync(fakePython, 0o700);
  const python = realPython || fakePython;
  if (process.env.OMB_MLX_NO_BROWSER !== "1") {
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    ui = await mountPreview(fixture, { entry: "/scripts/testing/mlx-preview.tsx", route: "/__mlx.html", title: "Isolated MLX settings" });
    const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
    browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
    const page = await (browser as any).newPage({ viewport: { width: 1100, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(ui.previewUrl);
    await page.evaluate(async (code: string) => fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "MLX fixture" }) }), pairing.code);
    await page.reload();
    await page.getByLabel("CSGHub platform API base URL", { exact: true }).fill(hub.endpoint);
    await page.getByLabel("Access Token", { exact: true }).fill("wrong-token");
    await page.getByRole("button", { name: "Connect and verify", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "refused" }).waitFor();
    await page.getByLabel("Access Token", { exact: true }).fill("fixture-secret");
    await page.getByRole("button", { name: "Connect and verify", exact: true }).click();
    await page.getByText("Connected as fixture-user", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Access Token", { exact: true }).inputValue(), "");
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByText("Isolated MLX fixture", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Download", exact: true }).first().click();
    await page.getByRole("button", { name: "Delete local copy", exact: true }).waitFor({ timeout: 180_000 });
    await page.getByLabel("Python executable", { exact: true }).fill(python);
    await page.getByRole("button", { name: "Verify existing environment", exact: true }).click();
    await page.getByText("Inference runtime: Ready", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.getByRole("button", { name: "Unload", exact: true }).waitFor({ timeout: 120_000 });
    await page.screenshot({ path: join(output, "mlx-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(output, "mlx-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } else {
    await api("POST", "/api/mlx/connect", { endpoint: hub.endpoint, token: "fixture-secret" });
    await api("POST", "/api/mlx/download", { repo: "team/fixture-mlx", revision: "main" });
    const deadline = Date.now() + 180_000;
    while (!(await status()).models.length) {
      const current = await status();
      assert.ok(!current.downloads.some((j) => j.state === "failed"), JSON.stringify(current));
      assert.ok(Date.now() < deadline, "Model download timed out");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await api("POST", "/api/mlx/runtime/configure", { python });
  }
  const local = await status();
  const model = local.models[0]!;
  assert.equal(model.backend, hub.config.model_type === "kda" ? "ssm-mlx" : "mlx-lm");
  assert.ok(!JSON.stringify(local).includes("fixture-secret"));
  assert.ok(!readFileSync(join(fixture.info.dataDir, "mlx", "connection.enc")).includes(Buffer.from("fixture-secret")));
  await control(["doctor"]);
  const created = await control(["new-bot", "--name", "MLX verification"]);
  const botId = created.bot.id;
  await control(["set-model", "--bot", botId, "--instance", "mlxLocal", "--model", model.id]);
  await api("PATCH", `/api/bots/${botId}`, { computer: "off", mcpServers: [], toolScope: { allow: [] } });
  await control(["send", "--bot", botId, "--text", realModel ? "法国的首都是哪里？请用一句话回答。" : "Hello from local MLX"]);
  const waited = await control(["wait", "--bot", botId, "--timeout", "120"]);
  assert.equal(waited.status, "settled");
  const messages = await control(["messages", "--bot", botId]);
  assert.match(JSON.stringify(messages), realModel ? /巴黎|Paris/ : /Local fixture:/);
  await api("POST", "/api/mlx/unload", {});
  await api("POST", "/api/mlx/disconnect", {});
  const disconnected = await status();
  assert.equal(disconnected.authenticated, false);
  assert.equal(disconnected.models.length, 1);
  assert.equal(disconnected.loaded, null);
  assert.ok(!readFileSync(fixture.info.logPath, "utf8").includes("fixture-secret"));
  evidence.push({ state: disconnected, requests: hub.requests, passed: true });
  writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, realModel: Boolean(realModel) }));
} finally {
  writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  await browser?.close(); await ui?.close(); await fixture.close(); await hub.close();
}
