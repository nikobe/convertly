import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);

export interface Binary {
  path: string;
  version: string;
  /** Where it came from, so the health strip can say why. */
  source: "config" | "vendor" | "path" | "jellyfin";
}

/**
 * Search order for ffmpeg/ffprobe, most deliberate first.
 *
 * Jellyfin's bundled copy is last and only a fallback: a Jellyfin update can
 * replace or remove it underneath us, and its build flags are not ours to
 * rely on. The health check names the source so a surprise is visible.
 */
function candidates(tool: "ffmpeg" | "ffprobe", configured: string | null): { path: string; source: Binary["source"] }[] {
  const out: { path: string; source: Binary["source"] }[] = [];
  if (configured) out.push({ path: configured, source: "config" });
  out.push({ path: join(process.cwd(), "vendor", "ffmpeg", tool), source: "vendor" });
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    out.push({ path: join(dir, tool), source: "path" });
  }
  out.push({ path: `/Applications/Jellyfin.app/Contents/MacOS/${tool}`, source: "jellyfin" });
  return out;
}

export async function locate(tool: "ffmpeg" | "ffprobe", configured: string | null): Promise<Binary> {
  const tried: string[] = [];
  for (const candidate of candidates(tool, configured)) {
    if (!existsSync(candidate.path)) {
      tried.push(candidate.path);
      continue;
    }
    try {
      const { stdout } = await run(candidate.path, ["-version"], { timeout: 10_000 });
      const version = stdout.split("\n")[0]?.trim() ?? "unknown";
      return { path: candidate.path, version, source: candidate.source };
    } catch {
      tried.push(candidate.path);
    }
  }
  throw new Error(
    `Could not find a working ${tool}. Looked in:\n  ${tried.join("\n  ")}\n` +
      `Install one, or set "${tool}Path" in your config.`,
  );
}
