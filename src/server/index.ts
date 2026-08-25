import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { existsSync } from "node:fs";
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

  const ffprobe = await locate("ffprobe", config.ffprobePath);
  // ffmpeg is not needed until phase 02, so a missing one is reported by the
  // health check rather than blocking startup.
  let ffmpeg: Binary | null = null;
  try {
    ffmpeg = await locate("ffmpeg", config.ffmpegPath);
  } catch {
    ffmpeg = null;
  }

  const store = new Store(config.dataDir);
  const scanner = new Scanner(config, store, ffprobe.path);

  // A crash or a power cut mid-encode leaves temp files behind; clear them
  // before anything else can trip over them. Quarantine is swept on the same
  // pass so expired originals do not sit on the drive indefinitely.
  const sweptTemp = sweepTempDirs(config.roots);
  const sweptQuarantine = sweepQuarantine(config.roots);

  const integrations = new Integrations(config.integrations);
  const governors = new Governors(config.governors, config.integrations.plex);

  const queue = new Queue({
    store,
    integrations,
    governors,
    roots: config.roots,
    ffmpegPath: ffmpeg?.path ?? "",
    ffprobePath: ffprobe.path,
    ffmpegVersion: ffmpeg?.version ?? "unknown",
  });

  const app = Fastify({
    logger: { transport: undefined, level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 256 * 1024,
  });

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

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    // Stop the encoder before anything else: an orphaned ffmpeg outlives the
    // process that started it and there is nothing left to reap it.
    queue.shutdown();
    closeOpenStreams();
    // A stuck close is worse than an abrupt one: the process stayed alive,
    // kept draining the queue, and a deploy started a second server beside it.
    const forced = setTimeout(() => process.exit(0), 4000);
    forced.unref?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await app.close();
      store.close();
    } catch {
      /* going down regardless */
    }
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ host: config.host, port: config.port });
  // Anything left queued from last time starts as soon as we are listening.
  void queue.drain();
  app.log.info(`ffprobe ${ffprobe.version} (${ffprobe.source})`);
  app.log.info(`roots: ${config.roots.map((r) => r.label).join(", ")}`);
  for (const url of reachableUrls(config.port)) app.log.info(`open ${url}`);
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
