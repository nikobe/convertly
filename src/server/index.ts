import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { loadConfig, ConfigError } from "./config.ts";
import { Store } from "./db.ts";
import { Scanner } from "./scanner.ts";
import { locate, type Binary } from "./binaries.ts";
import { registerApi, closeOpenStreams } from "./routes/api.ts";
import { parseClientRules, isClientAllowed, isExposedHost, reachableUrls } from "./access.ts";
import { Queue } from "./queue.ts";
import { Integrations } from "./integrations.ts";
import { Governors } from "./governors.ts";
import { sweepTempDirs } from "./pipeline.ts";
import { sweepQuarantine } from "./replace.ts";
import { acquireInstance } from "./instance.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n  Convertly can't start.\n\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Reserve the real listening socket before touching the store or media.
  // The factory returns 503 until routes and runtime state are fully ready.
  // Unlike a probe-then-close port check, ownership has no race window.
  let ready = false;
  let closing = false;
  let store: Store | undefined;
  let queue: Queue | undefined;
  const app = Fastify({
    logger: { transport: undefined, level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 256 * 1024,
    serverFactory: (handler) => createServer((request, response) => {
      if (!ready || closing) {
        response.writeHead(503, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "Convertly is starting or stopping." }));
        return;
      }
      handler(request, response);
    }),
  });

  const close = async () => {
    if (closing) return;
    closing = true;
    queue?.shutdown();
    closeOpenStreams();
    const forced = setTimeout(() => process.exit(1), 4000);
    forced.unref();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      // We bind the factory's server directly, so close it explicitly too.
      await Promise.all([
        app.close(),
        new Promise<void>((resolve) => app.server.close(() => resolve())),
      ]);
      store?.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen({ host: config.host, port: config.port }, () => {
      app.server.removeListener("error", reject);
      resolve();
    });
  });
  const release = acquireInstance(config.dataDir);
  process.once("exit", release);

  const ffprobe = await locate("ffprobe", config.ffprobePath);
  let ffmpeg: Binary | null = null;
  try {
    ffmpeg = await locate("ffmpeg", config.ffmpegPath);
  } catch {
    // Browsing still works without an encoder; health reports the limitation.
  }
  if (closing) return;

  store = new Store(config.dataDir);
  const scanner = new Scanner(config, store, ffprobe.path);
  // Preserve all pending references, not just a guessed subset of states.
  const pending = store.listQueue().flatMap((row) => row.pending_path ? [row.pending_path] : []);
  const sweptTemp = sweepTempDirs(config.roots, pending);
  const sweptQuarantine = sweepQuarantine(config.roots);
  const integrations = new Integrations(config.integrations);
  const governors = new Governors(config.governors, config.integrations.plex);
  queue = new Queue({
    store, integrations, governors, roots: config.roots,
    ffmpegPath: ffmpeg?.path ?? "", ffprobePath: ffprobe.path,
    ffmpegVersion: ffmpeg?.version ?? "unknown",
  });
  // A controlled upgrade can explicitly hold work even when the old version
  // did not persist its pause flag. No conversion starts before this point.
  if (process.env.CONVERTLY_START_PAUSED === "1") queue.pause();

  // Refuse anything that is not on the allowlist before it reaches a route.
  // There is no password: reachability is the whole of the access control.
  const clientRules = parseClientRules(config.allowedClients);
  app.addHook("onRequest", async (request, reply) => {
    if (isClientAllowed(request.ip, clientRules)) return;
    request.log.warn({ ip: request.ip, url: request.url }, "refused a client outside allowedClients");
    return reply.code(403).send({ error: "Not permitted from this address." });
  });

  await registerApi(app, { config, store, scanner, ffprobe, ffmpeg, queue, integrations, governors });

  // Built UI, when it exists. In development Vite serves it on its own port
  // and proxies /api here, so this is absent and that is fine.
  const webDir = join(process.cwd(), "dist", "web");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "No such endpoint." });
      return reply.sendFile("index.html");
    });
  }

  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listening address.");
  const identity = {
    app: "convertly", instanceId: randomUUID(), pid: process.pid,
    cwd: process.cwd(), dataDir: resolve(config.dataDir),
    configPath: resolve(process.env.CONVERTLY_CONFIG ?? "config/convertly.json"),
    logPath: process.env.CONVERTLY_LOG_PATH ?? null,
    host: config.host, port: address.port, startedAt: new Date().toISOString(),
  };
  app.get("/api/service", async () => identity);
  await app.ready();
  const metadataPath = join(config.dataDir, "service.json");
  writeFileSync(metadataPath + ".tmp", JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  renameSync(metadataPath + ".tmp", metadataPath);
  ready = true;
  app.log.info(`Server listening at ${identity.host === "::" ? "http://[::]" : `http://${identity.host}`}:${identity.port}`);
  // Anything left queued from last time starts as soon as we are listening.
  void queue.drain();
  app.log.info(`ffprobe ${ffprobe.version} (${ffprobe.source})`);
  app.log.info(`roots: ${config.roots.map((r) => r.label).join(", ")}`);
  for (const url of reachableUrls(identity.port)) app.log.info(`open ${url}`);
  app.log.info(`accepting: ${config.allowedClients.join(", ")}`);
  if (isExposedHost(config.host) && config.allowedClients.includes("*")) {
    app.log.warn("bound beyond this machine with allowedClients ['*'] — anything that can reach the port can re-encode your media");
  }
  if (sweptTemp.length > 0) app.log.info(`cleared ${sweptTemp.length} temp dir(s) left by a previous run`);
  if (sweptQuarantine.removed.length > 0) {
    app.log.info(`quarantine sweep freed ${(sweptQuarantine.freedBytes / 1e9).toFixed(2)} GB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
