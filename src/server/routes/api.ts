import type { FastifyInstance } from "fastify";
import { statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Scanner } from "../scanner.ts";
import type { Binary } from "../binaries.ts";
import { resolveWithinRoots, PathNotAllowedError } from "../paths.ts";
import type { JobRunner } from "../jobs.ts";
import { DEFAULT_PRESET, type Preset } from "../../shared/preset.ts";
import type { Selection } from "../../shared/estimate.ts";
import type { HealthReport } from "../../shared/types.ts";
import { formatBytes } from "../../shared/format.ts";

export interface Deps {
  config: Config;
  store: Store;
  scanner: Scanner;
  ffprobe: Binary;
  ffmpeg: Binary | null;
  jobs: JobRunner;
}

export async function registerApi(app: FastifyInstance, deps: Deps): Promise<void> {
  const { config, store, scanner, ffprobe, ffmpeg, jobs } = deps;

  app.get("/api/health", async (): Promise<HealthReport> => {
    const checks: HealthReport["checks"] = [
      { id: "ffprobe", label: "ffprobe", ok: true, detail: `${ffprobe.version} (${ffprobe.source})` },
      ffmpeg
        ? { id: "ffmpeg", label: "ffmpeg", ok: true, detail: `${ffmpeg.version} (${ffmpeg.source})` }
        : { id: "ffmpeg", label: "ffmpeg", ok: false, detail: "Not found — required from phase 02 onward." },
      { id: "cache", label: "Probe cache", ok: true, detail: `${store.countProbes().toLocaleString()} files known` },
      (() => {
        const saved = store.savings();
        return {
          id: "savings",
          label: "Recovered",
          ok: true,
          detail: saved.files === 0
            ? "Nothing converted yet"
            : `${formatBytes(saved.bytes)} across ${saved.files} file${saved.files === 1 ? "" : "s"}`,
        };
      })(),
    ];

    checks.push({
      id: "access",
      label: "Reachable from",
      ok: !config.allowedClients.includes("*"),
      detail: config.allowedClients.includes("*")
        ? `Any address (${config.host}:${config.port}) — no restriction`
        : `${config.host}:${config.port} · ${config.allowedClients.join(", ")}`,
    });

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

  // ── presets ──────────────────────────────────────────────────────────

  app.get("/api/presets", async () => ({
    presets: store.listPresets(),
    active: store.defaultPreset(),
    builtIn: DEFAULT_PRESET,
  }));

  app.put("/api/presets/default", async (request, reply) => {
    const body = request.body as Partial<Preset> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "A preset is required." });

    const merged: Preset = { ...DEFAULT_PRESET, ...body, id: "default", name: body.name?.slice(0, 60) || "My default" };
    const problem = validatePreset(merged);
    if (problem) return reply.code(400).send({ error: problem });

    return store.savePreset(merged, true);
  });

  // ── jobs ─────────────────────────────────────────────────────────────

  app.get("/api/jobs", async () => jobs.list());

  app.post("/api/jobs", async (request, reply) => {
    if (!ffmpeg) return reply.code(503).send({ error: "No ffmpeg available — nothing can be encoded." });

    const body = request.body as {
      path?: string;
      selection?: Selection;
      preset?: Partial<Preset>;
      replace?: boolean;
    };
    if (!body?.path) return reply.code(400).send({ error: "A path is required." });

    let resolved;
    try {
      resolved = resolveWithinRoots(body.path, config.roots);
    } catch {
      return reply.code(403).send({ error: "That file is outside your configured media roots." });
    }

    try {
      const job = await jobs.start({
        path: resolved.path,
        selection: body.selection,
        // An explicit preset wins; otherwise the saved default, not the built-in.
        preset: { ...store.defaultPreset(), ...body.preset },
        // Replacing has to be asked for explicitly. The default encodes and
        // verifies, then waits for a person.
        replace: body.replace === true,
      });
      return reply.code(202).send(job);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  /** Live job updates. One-way, so SSE rather than a socket layer. */
  app.get("/api/jobs/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(jobs.list())}\n\n`);

    const unsubscribe = jobs.subscribe((job) => {
      reply.raw.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    });
    // Proxies and laptops closing lids both kill idle streams; a comment frame
    // is cheap and keeps it alive.
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  app.post("/api/jobs/:id/accept", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return jobs.accept(id);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/api/jobs/:id/discard", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return jobs.discard(id);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    jobs.cancel(id);
    return reply.code(202).send({ ok: true });
  });

  app.delete("/api/bookmarks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) return reply.code(400).send({ error: "Bad bookmark id." });
    if (!store.removeBookmark(numeric)) return reply.code(404).send({ error: "No such bookmark." });
    return reply.code(204).send();
  });
}

/** Keep a hand-edited or stale preset from producing a nonsense command. */
function validatePreset(preset: Preset): string | null {
  if (!Number.isInteger(preset.crf) || preset.crf < 14 || preset.crf > 30) {
    return "Quality must be between 14 and 30.";
  }
  if (!["veryfast", "fast", "medium", "slow", "slower"].includes(preset.x265Preset)) {
    return "Unknown encoder speed.";
  }
  if (preset.maxHeight !== null && (!Number.isInteger(preset.maxHeight) || preset.maxHeight < 240 || preset.maxHeight > 4320)) {
    return "A resolution cap must be between 240 and 4320, or off.";
  }
  if (![192_000, 224_000, 384_000, 448_000, 640_000].includes(preset.ac3Bitrate)) {
    return "Unsupported AC3 bitrate.";
  }
  return null;
}
