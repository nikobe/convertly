import { readFileSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { Root } from "../shared/types.ts";

export interface Config {
  host: string;
  port: number;
  roots: Root[];
  ffprobePath: string | null;
  ffmpegPath: string | null;
  scanConcurrency: number;
  videoExtensions: string[];
  dataDir: string;
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8973,
  scanConcurrency: 4,
  videoExtensions: [".mkv", ".mp4", ".m4v", ".avi", ".ts", ".m2ts", ".mov", ".wmv", ".mpg", ".mpeg", ".divx"],
};

export class ConfigError extends Error {}

/**
 * Load config from disk. Roots are resolved through realpath at load time so
 * the allowlist compares canonical paths — a symlink pointing outside a root
 * cannot then be used to escape it.
 */
export function loadConfig(path = process.env.CONVERTLY_CONFIG ?? "config/convertly.json"): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config at ${path}. Copy config/convertly.example.json to config/convertly.json and set your media roots.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new ConfigError(`Config at ${path} must be an object.`);
  const obj = raw as Record<string, unknown>;

  const roots = parseRoots(obj.roots, path);

  return {
    host: typeof obj.host === "string" ? obj.host : DEFAULTS.host,
    port: typeof obj.port === "number" ? obj.port : DEFAULTS.port,
    roots,
    ffprobePath: typeof obj.ffprobePath === "string" ? obj.ffprobePath : null,
    ffmpegPath: typeof obj.ffmpegPath === "string" ? obj.ffmpegPath : null,
    scanConcurrency:
      typeof obj.scanConcurrency === "number" && obj.scanConcurrency > 0
        ? Math.min(obj.scanConcurrency, 16)
        : DEFAULTS.scanConcurrency,
    videoExtensions: Array.isArray(obj.videoExtensions)
      ? obj.videoExtensions.filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase())
      : DEFAULTS.videoExtensions,
    dataDir: typeof obj.dataDir === "string" ? obj.dataDir : "data",
  };
}

function parseRoots(value: unknown, configPath: string): Root[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`Config at ${configPath} needs at least one entry in "roots".`);
  }

  const seen = new Set<string>();
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigError(`roots[${i}] must be an object with id, label and path.`);
    }
    const { id, label, path: rootPath } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) throw new ConfigError(`roots[${i}].id must be a non-empty string.`);
    if (typeof label !== "string" || !label) throw new ConfigError(`roots[${i}].label must be a non-empty string.`);
    if (typeof rootPath !== "string" || !isAbsolute(rootPath)) {
      throw new ConfigError(`roots[${i}].path must be an absolute path.`);
    }
    if (seen.has(id)) throw new ConfigError(`Duplicate root id "${id}".`);
    seen.add(id);

    // Canonicalise now if the volume is mounted. An unmounted drive is not a
    // config error — the health check reports it and browsing it fails cleanly.
    let canonical = resolve(rootPath);
    try {
      canonical = realpathSync(canonical);
    } catch {
      /* not mounted yet */
    }
    return { id, label, path: canonical };
  });
}
