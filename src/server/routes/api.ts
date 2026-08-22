import type { FastifyInstance } from "fastify";
import { statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Scanner } from "../scanner.ts";
import type { Binary } from "../binaries.ts";
import { resolveWithinRoots, PathNotAllowedError } from "../paths.ts";
import type { HealthReport } from "../../shared/types.ts";

export interface Deps {
  config: Config;
  store: Store;
  scanner: Scanner;
  ffprobe: Binary;
  ffmpeg: Binary | null;
}

export async function registerApi(app: FastifyInstance, deps: Deps): Promise<void> {
  const { config, store, scanner, ffprobe, ffmpeg } = deps;

  app.get("/api/health", async (): Promise<HealthReport> => {
    const checks: HealthReport["checks"] = [
      { id: "ffprobe", label: "ffprobe", ok: true, detail: `${ffprobe.version} (${ffprobe.source})` },
      ffmpeg
        ? { id: "ffmpeg", label: "ffmpeg", ok: true, detail: `${ffmpeg.version} (${ffmpeg.source})` }
        : { id: "ffmpeg", label: "ffmpeg", ok: false, detail: "Not found — required from phase 02 onward." },
      { id: "cache", label: "Probe cache", ok: true, detail: `${store.countProbes().toLocaleString()} files known` },
    ];

    for (const root of config.roots) {
      const mounted = existsSync(root.path);
      checks.push({
        id: `root:${root.id}`,
        label: root.label,
        ok: mounted,
        detail: mounted ? root.path : `Not mounted: ${root.path}`,
      });
    }

    return { ok: checks.every((c) => c.ok), checks };
  });

  app.get("/api/roots", async () => config.roots);

  app.get("/api/browse", async (request, reply) => {
    const query = request.query as { path?: string };
    const requested = query.path ?? config.roots[0]?.path;
    if (!requested) return reply.code(400).send({ error: "No media roots are configured." });

    let resolved;
    try {
      resolved = resolveWithinRoots(requested, config.roots);
    } catch (err) {
      if (err instanceof PathNotAllowedError) {
        return reply.code(403).send({ error: "That folder is outside your configured media roots." });
      }
      throw err;
    }

    if (!existsSync(resolved.path)) {
      return reply.code(404).send({ error: `Folder not found. Is ${resolved.root.label} mounted?` });
    }
    if (!statSync(resolved.path).isDirectory()) {
      return reply.code(400).send({ error: "That path is a file, not a folder." });
    }

    return scanner.browse(resolved.path, resolved.root);
  });

  app.get("/api/bookmarks", async () => store.listBookmarks());

  app.post("/api/bookmarks", async (request, reply) => {
    const body = request.body as { path?: string; label?: string };
    if (!body?.path) return reply.code(400).send({ error: "A path is required." });

    let resolved;
    try {
      resolved = resolveWithinRoots(body.path, config.roots);
    } catch {
      return reply.code(403).send({ error: "That folder is outside your configured media roots." });
    }

    const label = (body.label ?? "").trim() || basename(resolved.path) || resolved.root.label;
    return store.addBookmark(label.slice(0, 80), resolved.path, resolved.root.id);
  });

  app.delete("/api/bookmarks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) return reply.code(400).send({ error: "Bad bookmark id." });
    if (!store.removeBookmark(numeric)) return reply.code(404).send({ error: "No such bookmark." });
    return reply.code(204).send();
  });
}
