import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { buildCommand, BuildError } from "./ffmpeg-args.ts";
import { Encode, type Progress } from "./encoder.ts";
import { verify, type Check } from "./verify.ts";
import { replaceInPlace, type ReplaceRecord } from "./replace.ts";
import { probeFile } from "./probe.ts";
import type { Probe, Root } from "../shared/types.ts";
import type { Preset } from "../shared/preset.ts";
import type { Selection } from "../shared/estimate.ts";
import { formatBytes } from "../shared/format.ts";

/** Encoding happens here, on the source's own volume, so the swap is a rename. */
export const TEMP_DIRNAME = ".convertly-tmp";

export type JobOutcome = "replaced" | "review" | "failed" | "cancelled";

export interface JobResult {
  outcome: JobOutcome;
  /** Why, in words a person can act on. */
  message: string;
  checks: Check[];
  record: ReplaceRecord | null;
  /** Kept when the outcome is "review", so it can be accepted without re-encoding. */
  pendingPath: string | null;
  command: string[];
  encoder: string;
  ffmpegVersion: string;
  elapsedSec: number;
  vmaf: number | null;
}

export interface JobOptions {
  probe: Probe;
  selection: Selection;
  preset: Preset;
  roots: Root[];
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  /** Stop before touching the original. Used to prove a pipeline safely. */
  dryRun?: boolean;
}

/**
 * One file, end to end: encode, verify, then swap — and only in that order.
 *
 * Nothing touches the original until every check has passed. A failure leaves
 * the library exactly as it was; a "review" keeps the encode so accepting it
 * later costs nothing.
 */
export async function runJob(options: JobOptions): Promise<JobResult> {
  const { probe, selection, preset, roots, ffmpegPath, ffprobePath, ffmpegVersion, onProgress, signal, dryRun } = options;

  const tempDir = join(dirname(probe.path), TEMP_DIRNAME);
  const tempPath = join(tempDir, `${basename(probe.path, ".mkv")}.${Date.now()}.mkv`);

  const base = (outcome: JobOutcome, message: string, extra: Partial<JobResult> = {}): JobResult => ({
    outcome, message, checks: [], record: null, pendingPath: null,
    command: [], encoder: "", ffmpegVersion, elapsedSec: 0, vmaf: null, ...extra,
  });

  let built;
  try {
    built = buildCommand({ probe, selection, preset, outputPath: tempPath });
  } catch (err) {
    if (err instanceof BuildError) return base("failed", err.message);
    throw err;
  }

  mkdirSync(tempDir, { recursive: true });
  const cleanup = () => {
    try {
      if (existsSync(tempPath)) rmSync(tempPath);
    } catch {
      /* leave it for the boot sweep */
    }
  };

  // ── encode ───────────────────────────────────────────────────────────
  const encode = new Encode();
  const result = await encode.run({
    ffmpegPath,
    args: built.args,
    durationSec: probe.durationSec,
    onProgress,
    signal,
  });

  const common = {
    command: [ffmpegPath, ...built.args],
    encoder: built.encoder,
    elapsedSec: result.elapsedSec,
  };

  if (result.cancelled) {
    cleanup();
    return base("cancelled", "Cancelled before anything was replaced.", common);
  }
  if (!result.ok) {
    cleanup();
    const firstLine = result.stderr.split("\n").filter(Boolean).pop() ?? `exit code ${result.exitCode}`;
    return base("failed", `ffmpeg failed, original untouched: ${firstLine}`, common);
  }

  // ── verify ───────────────────────────────────────────────────────────
  const verification = await verify({
    ffmpegPath,
    ffprobePath,
    source: probe,
    outputPath: tempPath,
    selection,
    expectedAudioStreams: built.expectedAudioStreams,
    expectedSubtitleStreams: built.expectedSubtitleStreams,
    skipVmaf: built.encoder === "copy",
    signal,
  });

  const withChecks = { ...common, checks: verification.checks, vmaf: verification.vmaf };

  if (!verification.ok && !verification.needsReview) {
    const failed = verification.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`);
    cleanup();
    return base("failed", `Verification failed, original untouched. ${failed.join("; ")}`, withChecks);
  }

  if (verification.needsReview) {
    const flagged = verification.checks.filter((c) => c.status === "review").map((c) => `${c.label}: ${c.detail}`);
    return base(
      "review",
      `Encoded, but held for you to look at: ${flagged.join("; ")}. The original is untouched and the encode is kept.`,
      { ...withChecks, pendingPath: tempPath },
    );
  }

  if (dryRun) {
    return base("review", "Encoded and verified. The original is untouched — accept to swap it in.", {
      ...withChecks,
      pendingPath: tempPath,
    });
  }

  // ── swap ─────────────────────────────────────────────────────────────
  const record = replaceInPlace(probe.path, tempPath, roots);
  const saved = record.originalSize - record.newSize;
  return base(
    "replaced",
    `Replaced in place, ${formatBytes(saved)} saved. Original kept in quarantine.`,
    { ...withChecks, record },
  );
}

/** Re-probe a path just before a job, so a stale cache cannot drive an encode. */
export async function freshProbe(ffprobePath: string, path: string): Promise<Probe> {
  if (!existsSync(path)) throw new Error(`File has gone: ${path}`);
  statSync(path);
  return probeFile(ffprobePath, path);
}

/** Remove temp files left by a crash or a power cut. Called at boot. */
export function sweepTempDirs(roots: Root[]): string[] {
  const removed: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === TEMP_DIRNAME) {
        try {
          rmSync(path, { recursive: true, force: true });
          removed.push(path);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      walk(path, depth + 1);
    }
  };
  for (const root of roots) walk(root.path, 0);
  return removed;
}
