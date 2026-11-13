import { createServer } from "node:http";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export async function startFakeCsgHub(source?: string) {
  const files = new Map<string, Buffer | string>(source
    ? readdirSync(source).filter((name) => /\.(json|safetensors|model|jinja|txt)$/.test(name) && statSync(join(source, name)).isFile()).map((name) => [name, join(source, name)])
    : [["config.json", Buffer.from('{"model_type":"llama"}')], ["tokenizer.json", Buffer.from("{}")], ["model.safetensors", Buffer.from("synthetic weights")]]);
  const sha = "a".repeat(40);
  const requests: Array<{ path: string; authorized: boolean }> = [];
  const state = { corrupt: false, slow: false, unsafe: false, redirect: "" };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const authorized = req.headers.authorization === "Bearer fixture-secret";
    requests.push({ path: req.url!, authorized });
    if (!authorized) { res.writeHead(401).end(); return; }
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/csg/api/whoami-v2") { json({ name: "fixture-user" }); return; }
    if (url.pathname === "/api/v1/models" || url.pathname === "/api/v1/user/fixture-user/models") {
      json({ data: [{ path: "team/fixture-mlx", private: true, tags: [{ name: "mlx" }], description: "Isolated MLX fixture" }], total: 1 }); return;
    }
    if (url.pathname.startsWith("/csg/api/models/team/fixture-mlx/revision/")) {
      json({ sha, siblings: [...files].map(([rfilename, value]) => {
        const size = typeof value === "string" ? statSync(value).size : value.length;
        return { rfilename: state.unsafe ? "../escape.json" : rfilename, size,
          ...(rfilename.endsWith(".safetensors") ? { lfs: { size, ...(state.corrupt ? { sha256: "0".repeat(64) } : typeof value !== "string" ? { sha256: createHash("sha256").update(value).digest("hex") } : {}) } } : {}) };
      }) }); return;
    }
    const prefix = `/csg/team/fixture-mlx/resolve/${sha}/`;
    if (url.pathname.startsWith(prefix)) {
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      const file = files.get(name);
      if (!file) { res.writeHead(404).end(); return; }
      if (state.redirect) { res.writeHead(302, { location: state.redirect }).end(); return; }
      if (state.slow) { res.writeHead(200); res.write("x"); return; }
      const size = typeof file === "string" ? statSync(file).size : file.length;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
      if (typeof file === "string") { const stream = createReadStream(file); stream.pipe(res); res.once("close", () => stream.destroy()); }
      else res.end(file);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, files, state, requests, sha,
    config: source ? JSON.parse(readFileSync(join(source, "config.json"), "utf8")) : {},
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
