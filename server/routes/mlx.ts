import { z } from "zod";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { MlxService } from "../mlx/service.ts";
import { repoSchema, revisionSchema } from "../mlx/hub.ts";

export function createMlxRoutes(deps: { mlx: MlxService; hosted: boolean; changed: () => void }): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (path !== "/api/mlx" && !path.startsWith("/api/mlx/")) return PASS;
    if (deps.hosted || !ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner of this local server can manage MLX models." });
    try {
      const { mlx } = deps;
      if (method === "GET" && path === "/api/mlx") return json(res, 200, mlx.status());
      if (method === "GET" && path === "/api/mlx/models") {
        const page = z.coerce.number().int().min(1).max(10000).parse(url.searchParams.get("page") ?? 1);
        const search = z.string().max(200).parse(url.searchParams.get("search") ?? "");
        return json(res, 200, await mlx.requireHub().list(search, page, url.searchParams.get("mine") === "true"));
      }
      if (method !== "POST") return json(res, 404, { error: "Unknown MLX operation." });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "Use application/json." });
      const body = await readBody(req);
      if (path === "/api/mlx/connect") await mlx.connect(body);
      else if (path === "/api/mlx/disconnect") await mlx.disconnect();
      else if (path === "/api/mlx/download") {
        const { repo, revision } = z.object({ repo: repoSchema, revision: revisionSchema.default("main") }).parse(body);
        return json(res, 202, mlx.storage.download(mlx.requireHub(), repo, revision));
      } else if (path === "/api/mlx/cancel") await mlx.storage.cancel(z.object({ id: z.string() }).parse(body).id);
      else if (path === "/api/mlx/runtime/install") {
        const { python } = z.object({ python: z.string().trim().min(1).max(1000).default("python3") }).parse(body);
        mlx.runtime.install(python);
      } else if (path === "/api/mlx/runtime/configure") {
        await mlx.runtime.configure(z.object({ python: z.string().trim().min(1).max(1000) }).parse(body).python);
      } else if (path === "/api/mlx/load") await mlx.runtime.load(z.object({ id: z.string() }).parse(body).id);
      else if (path === "/api/mlx/unload") mlx.runtime.unload();
      else if (path === "/api/mlx/remove") await mlx.runtime.remove(z.object({ id: z.string() }).parse(body).id);
      else return json(res, 404, { error: "Unknown MLX operation." });
      deps.changed();
      return json(res, 200, mlx.status());
    } catch (error) {
      return json(res, 400, { error: error instanceof z.ZodError ? "Invalid MLX settings or incompatible CSGHub response." : error instanceof Error ? error.message : "MLX operation failed." });
    }
  };
}
