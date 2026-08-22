import { readdirSync, statSync, statfsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { probeFile } from "./probe.ts";
import { assess } from "./classify.ts";
import { isWithin } from "./paths.ts";
import type { DirEntry, BrowseResponse, Root } from "../shared/types.ts";

/** Directories that are ours or the OS's, never the user's media. */
const SKIP_DIRS = new Set([".convertly-tmp", "quarantine", ".Trashes", ".Spotlight-V100", "@eaDir"]);

export class Scanner {
  private readonly config: Config;
  private readonly store: Store;
  private readonly ffprobePath: string;

  constructor(config: Config, store: Store, ffprobePath: string) {
    this.config = config;
    this.store = store;
    this.ffprobePath = ffprobePath;
  }

  isVideo(name: string): boolean {
    return this.config.videoExtensions.includes(extname(name).toLowerCase());
  }

  /**
   * List one directory. Probes are served from cache where size and mtime
   * still match; anything stale is probed now, bounded by scanConcurrency so
   * a folder of 400 files does not fork 400 ffprobes at once.
   */
  async browse(path: string, root: Root): Promise<BrowseResponse> {
    const names = readdirSync(path);
    const entries: DirEntry[] = [];
    const toProbe: DirEntry[] = [];

    for (const name of names) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const full = join(path, name);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue; // vanished or unreadable between readdir and stat
      }

      if (stat.isDirectory()) {
        entries.push({ name, path: full, kind: "dir", size: null, mtimeMs: stat.mtimeMs, probe: null, assessment: null });
        continue;
      }
      if (!stat.isFile()) continue;

      if (!this.isVideo(name)) {
        entries.push({ name, path: full, kind: "other", size: stat.size, mtimeMs: stat.mtimeMs, probe: null, assessment: null });
        continue;
      }

      const cached = this.store.getProbe(full, stat.size, stat.mtimeMs);
      const entry: DirEntry = {
        name, path: full, kind: "video", size: stat.size, mtimeMs: stat.mtimeMs,
        probe: cached, assessment: cached ? assess(cached) : null,
      };
      entries.push(entry);
      if (!cached) toProbe.push(entry);
    }

    await this.probeAll(toProbe);

    entries.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

    return {
      path,
      rootId: root.id,
      trail: buildTrail(path, root),
      parent: isWithin(root.path, dirname(path)) && path !== root.path ? dirname(path) : null,
      entries,
      volume: volumeInfo(path),
    };
  }

  private async probeAll(entries: DirEntry[]): Promise<void> {
    const queue = [...entries];
    const workers = Array.from({ length: Math.min(this.config.scanConcurrency, queue.length) }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          const probe = await probeFile(this.ffprobePath, entry.path);
          this.store.putProbe(probe);
          entry.probe = probe;
          entry.assessment = assess(probe);
        } catch {
          // A single unreadable file must not sink the directory listing.
          entry.probe = null;
          entry.assessment = null;
        }
      }
    });
    await Promise.all(workers);
  }
}

function buildTrail(path: string, root: Root): { label: string; path: string }[] {
  const trail = [{ label: root.label, path: root.path }];
  if (path === root.path) return trail;
  const rest = path.slice(root.path.length).split("/").filter(Boolean);
  let cursor = root.path;
  for (const segment of rest) {
    cursor = join(cursor, segment);
    trail.push({ label: segment, path: cursor });
  }
  return trail;
}

function volumeInfo(path: string): { totalBytes: number; freeBytes: number } | null {
  try {
    const fs = statfsSync(path);
    return { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
  } catch {
    return null;
  }
}

export { basename };
