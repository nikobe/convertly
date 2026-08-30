import { mkdirSync, rmSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve, sep } from "node:path";
import { buildCommand, BuildError } from "./ffmpeg-args.ts";
import { Encode, summarizeFfmpegError, type Progress } from "./encoder.ts";
import { verify, type Check, type VerifyStage } from "./verify.ts";
import { replaceInPlace, type ReplaceRecord } from "./replace.ts";
import { probeFile } from "./probe.ts";
import type { Probe, Root } from "../shared/types.ts";
import type { Preset } from "../shared/preset.ts";
import type { Selection } from "../shared/estimate.ts";
import { planContainer, withExtension } from "../shared/container.ts";
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
  /** Verification is a large slice of total time; report it or it looks stalled. */
  onStage?: (stage: VerifyStage) => void;
  /** Handed the live encoder so a governor can suspend and resume it. */
  onEncodeStart?: (encode: Encode) => void;
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
  const { probe, selection, preset, roots, ffmpegPath, ffprobePath, ffmpegVersion, onProgress, onStage, onEncodeStart, signal, dryRun } = options;

  const container = planContainer(probe.path);
  const tempDir = join(dirname(probe.path), TEMP_DIRNAME);
  // Strip whatever extension the source has, not just ".mkv": an AVI source
  // was producing "name.avi.<ts>.mkv", which then got renamed back to .avi
  // and left a Matroska file wearing an AVI extension.
  const stem = basename(withExtension(probe.path, ""), "");
  const tempPath = join(tempDir, `${stem}.${Date.now()}${container.extension}`);
  // Where it will actually live afterwards. Identical to the source unless the
  // container cannot carry HEVC.
  const finalPath = withExtension(probe.path, container.extension);

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
  onEncodeStart?.(encode);
  const result = await encode.run({
    ffmpegPath,
    args: built.args,
    durationSec: probe.durationSec,
    totalFrames: expectedFrames(probe),
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
    const detail = summarizeFfmpegError(result.stderr, result.exitCode);
    return base("failed", `ffmpeg failed, original untouched: ${detail}`, common);
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
    onStage,
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
  const record = replaceInPlace(probe.path, tempPath, roots, finalPath);
  const saved = record.originalSize - record.newSize;
  return base(
    "replaced",
    `Replaced${container.changed ? ` as ${container.extension}` : " in place"}, ` +
      `${formatBytes(saved)} saved. Original kept in quarantine.` +
      (container.changed ? " The filename changed, so rescan Sonarr/Radarr." : ""),
    { ...withChecks, record },
  );
}

/** Video frames the encode should produce, for measuring progress against. */
export function expectedFrames(probe: Probe): number | null {
  const fps = probe.video?.fps;
  if (!probe.durationSec || !fps || fps <= 0) return null;
  return Math.round(probe.durationSec * fps);
}

/** Re-probe a path just before a job, so a stale cache cannot drive an encode. */
export async function freshProbe(ffprobePath: string, path: string): Promise<Probe> {
  if (!existsSync(path)) throw new Error(`File has gone: ${path}`);
  statSync(path);
  return probeFile(ffprobePath, path);
}

/** Remove abandoned outputs, preserving everything still referenced by the queue. */
export function sweepTempDirs(roots: Root[], pendingPaths: readonly string[] = []): string[] {
  const removed: string[] = [];
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const protectedPaths = pendingPaths.map(canonical);
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
        // A review output is not debris from a crash. Keep its whole scratch
        // directory conservatively, including sidecars. Canonical paths also
        // handle /tmp vs /private/tmp and symlinked root configuration.
        const prefix = canonical(path) + sep;
        if (protectedPaths.some((pending) => pending === prefix.slice(0, -1) || pending.startsWith(prefix))) continue;
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
