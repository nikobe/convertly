import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, ConfigError } from "./config.ts";
import { Store } from "./db.ts";
import { Scanner } from "./scanner.ts";
import { locate, type Binary } from "./binaries.ts";
import { registerApi } from "./routes/api.ts";

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

  const app = Fastify({
    logger: { transport: undefined, level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 256 * 1024,
  });

  await registerApi(app, { config, store, scanner, ffprobe, ffmpeg });

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

  const close = async () => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`ffprobe ${ffprobe.version} (${ffprobe.source})`);
  app.log.info(`roots: ${config.roots.map((r) => r.label).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
