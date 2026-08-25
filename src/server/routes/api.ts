import type { FastifyInstance } from "fastify";
import { statSync, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { UnreadableError } from "../scanner.ts";
import type { Scanner } from "../scanner.ts";
import type { Binary } from "../binaries.ts";
import { resolveWithinRoots, PathNotAllowedError } from "../paths.ts";
import type { Queue } from "../queue.ts";
import type { Integrations } from "../integrations.ts";
import type { Governors } from "../governors.ts";
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
  queue: Queue;
  integrations: Integrations;
  governors: Governors;
}

/** Long-lived event streams, so they can be ended deliberately on shutdown. */
export const openStreams = new Set<{ end: () => void; destroy: () => void }>();

export function closeOpenStreams(): void {
  for (const stream of openStreams) {
    try {
      stream.end();
      stream.destroy();
    } catch {
      /* already gone */
    }
  }
  openStreams.clear();
}

export async function registerApi(app: FastifyInstance, deps: Deps): Promise<void> {
  const { config, store, scanner, ffprobe, ffmpeg, queue, integrations, governors } = deps;

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

    // Probed live so an unreachable Radarr shows up before a batch, not after.
    for (const outcome of await integrations.check()) {
      checks.push({
        id: `svc:${outcome.service}`,
        label: outcome.service === "plex" ? "Plex" : outcome.service === "radarr" ? "Radarr" : "Sonarr",
        ok: outcome.ok,
        detail: outcome.ok ? outcome.detail : `Configured but ${outcome.detail}`,
      });
    }
    if (!integrations.anyConfigured) {
      checks.push({
        id: "svc:none",
        label: "Library managers",
        ok: true,
        detail: "Not configured — rescan Radarr/Sonarr by hand after a batch",
      });
    }

    for (const root of config.roots) {
      checks.push({ id: `root:${root.id}`, label: root.label, ...readableRoot(root.path) });
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

    try {
      return await scanner.browse(resolved.path, resolved.root);
    } catch (err) {
      if (err instanceof UnreadableError) return reply.code(403).send({ error: err.message });
      throw err;
    }
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

  // ── queue ────────────────────────────────────────────────────────────

  app.get("/api/queue", async () => queue.snapshot());

  app.get("/api/governors", async () => {
    const status = await governors.evaluate();
    return {
      config: governors.current,
      verdict: status.verdict,
      thermal: status.thermal,
      playback: status.playback,
    };
  });

  app.post("/api/queue", async (request, reply) => {
    if (!ffmpeg) return reply.code(503).send({ error: "No ffmpeg available — nothing can be encoded." });

    const body = request.body as {
      items?: { path?: string; selection?: Selection }[];
      preset?: Partial<Preset>;
    };
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return reply.code(400).send({ error: "Nothing to add." });
    }

    const entries: { path: string; selection?: Selection }[] = [];
    const rejected: { path: string; reason: string }[] = [];
    for (const item of body.items) {
      if (!item?.path) continue;
      try {
        const resolved = resolveWithinRoots(item.path, config.roots);
        entries.push({ path: resolved.path, selection: item.selection });
      } catch {
        rejected.push({ path: item.path, reason: "Outside your configured media roots." });
      }
    }

    const preset = { ...store.defaultPreset(), ...body.preset };
    const result = await queue.add(entries, preset);
    return { added: result.added, skipped: [...result.skipped, ...rejected] };
  });

  /** Live queue updates. One-way, so SSE rather than a socket layer. */
  app.get("/api/queue/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (snapshot: unknown) => reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    send(queue.snapshot());
    const unsubscribe = queue.subscribe(send);
    // Held so shutdown can end them. Fastify's close waits for open
    // connections, and an event stream never closes by itself — which left a
    // server alive after SIGTERM, still working the queue, while a second one
    // started up beside it.
    openStreams.add(reply.raw);
    // Idle streams get dropped by proxies and sleeping laptops alike.
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      openStreams.delete(reply.raw);
    });
    return reply;
  });

  app.post("/api/queue/accept-all", async () => queue.acceptAll());

  app.post("/api/queue/pause", async () => { queue.pause(); return queue.snapshot(); });
  app.post("/api/queue/resume", async () => { queue.resume(); return queue.snapshot(); });
  app.post("/api/queue/clear", async () => ({ removed: queue.clearFinished() }));

  app.post("/api/queue/reorder", async (request, reply) => {
    const body = request.body as { ids?: string[] };
    if (!Array.isArray(body?.ids)) return reply.code(400).send({ error: "An ordered list of ids is required." });
    queue.reorder(body.ids.filter((id): id is string => typeof id === "string"));
    return queue.snapshot();
  });

  app.delete("/api/queue/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.remove(id)) return reply.code(404).send({ error: "No such queue item." });
    return reply.code(204).send();
  });

  for (const action of ["accept", "discard"] as const) {
    app.post(`/api/queue/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        queue[action](id);
        return queue.snapshot();
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    });
  }

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

/**
 * Can we actually read this root?
 *
 * existsSync is not enough. On macOS a volume can be mounted and stattable
 * while every readdir is refused by the privacy system, which had the health
 * strip reporting seven green roots on a machine that could not list one of
 * them.
 */
function readableRoot(path: string): { ok: boolean; detail: string } {
  if (!existsSync(path)) return { ok: false, detail: `Not mounted: ${path}` };
  try {
    const entries = readdirSync(path);
    return { ok: true, detail: `${path} · ${entries.length} item${entries.length === 1 ? "" : "s"}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return {
        ok: false,
        detail:
          `Mounted but not readable — macOS is blocking it. Give Full Disk Access to whatever ` +
          `starts the server (Terminal, or sshd for remote deploys) in System Settings › ` +
          `Privacy & Security, then restart it. Path: ${path}`,
      };
    }
    return { ok: false, detail: `Unreadable (${code ?? "unknown"}): ${path}` };
  }
}
