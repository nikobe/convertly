import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { probeFile } from "./probe.ts";
import type { Probe } from "../shared/types.ts";
import type { Selection } from "../shared/estimate.ts";
import { formatBytes } from "../shared/format.ts";

const run = promisify(execFile);

export type { Check, CheckStatus } from "../shared/check.ts";
import type { Check } from "../shared/check.ts";

export interface VerifyResult {
  /** Safe to replace the original. */
  ok: boolean;
  /** Encoded fine but wants a human decision before replacing. */
  needsReview: boolean;
  checks: Check[];
  outputProbe: Probe | null;
  vmaf: number | null;
}

/** Where verification has got to, so the UI never looks stalled. */
export interface VerifyStage {
  label: string;
  step: number;
  steps: number;
  /** 0–1 within this step, when the step can report it. */
  fraction: number | null;
}

export interface VerifyOptions {
  ffmpegPath: string;
  ffprobePath: string;
  source: Probe;
  outputPath: string;
  selection: Selection;
  /**
   * Stream counts the command builder said it would produce. Re-deriving them
   * from the selection was wrong the moment a job could add a track.
   */
  expectedAudioStreams?: number;
  expectedSubtitleStreams?: number;
  /** Mean VMAF below this holds the job for review. */
  vmafFloor?: number;
  /** Output must be at least this much smaller, or it is not worth swapping. */
  minShrinkRatio?: number;
  /** Seconds of video to sample for VMAF. More is slower and barely better. */
  vmafSampleSeconds?: number;
  /** Skip VMAF — for a stream-copy job, where there is nothing to measure. */
  skipVmaf?: boolean;
  onStage?: (stage: VerifyStage) => void;
  signal?: AbortSignal;
}

const DURATION_TOLERANCE_SEC = 0.5;

/**
 * Everything that must hold before an original is touched.
 *
 * A failure aborts and keeps the source. "review" means the encode is sound
 * but the result is not obviously good enough to swap in unattended.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const {
    ffmpegPath, ffprobePath, source, outputPath, selection,
    expectedAudioStreams, expectedSubtitleStreams,
    vmafFloor = 93, minShrinkRatio = 0.15, vmafSampleSeconds = 120, skipVmaf = false, onStage, signal,
  } = options;

  const STEPS = skipVmaf ? 5 : 6;
  const stage = (step: number, label: string, fraction: number | null = null) =>
    onStage?.({ label, step, steps: STEPS, fraction });

  const checks: Check[] = [];
  let outputProbe: Probe | null = null;
  let vmaf: number | null = null;

  // ── the output exists and is readable ────────────────────────────────
  stage(1, "Reading the output");
  try {
    outputProbe = await probeFile(ffprobePath, outputPath);
    if (outputProbe.error) throw new Error(outputProbe.error);
    checks.push({ id: "readable", label: "Output readable", status: "pass", detail: `${outputProbe.container ?? "unknown"} container` });
  } catch (err) {
    checks.push({ id: "readable", label: "Output readable", status: "fail", detail: (err as Error).message });
    return { ok: false, needsReview: false, checks, outputProbe: null, vmaf: null };
  }

  // ── duration ─────────────────────────────────────────────────────────
  stage(2, "Checking duration and tracks");
  if (source.durationSec && outputProbe.durationSec) {
    const drift = Math.abs(source.durationSec - outputProbe.durationSec);
    checks.push({
      id: "duration",
      label: "Duration",
      status: drift <= DURATION_TOLERANCE_SEC ? "pass" : "fail",
      detail: `${outputProbe.durationSec.toFixed(2)}s against ${source.durationSec.toFixed(2)}s — ${drift.toFixed(2)}s drift`,
    });
  } else {
    checks.push({ id: "duration", label: "Duration", status: "skipped", detail: "No duration reported on one side." });
  }

  // ── every kept track arrived ─────────────────────────────────────────
  const wantedAudio = expectedAudioStreams ?? source.audio.filter((t) => selection.audio.includes(t.index)).length;
  const wantedSubs = expectedSubtitleStreams ?? source.subtitles.filter((t) => selection.subtitles.includes(t.index)).length;
  const gotAudio = outputProbe.audio.length;
  const gotSubs = outputProbe.subtitles.length;
  const censusOk = gotAudio === wantedAudio && gotSubs === wantedSubs;
  checks.push({
    id: "census",
    label: "Track census",
    status: censusOk ? "pass" : "fail",
    detail: `${gotAudio}/${wantedAudio} audio, ${gotSubs}/${wantedSubs} subtitles`,
  });

  // Chapters are easy to lose silently and annoying to notice later.
  checks.push({
    id: "chapters",
    label: "Chapters",
    status: source.chapters === 0 || outputProbe.chapters === source.chapters ? "pass" : "review",
    detail: `${outputProbe.chapters} of ${source.chapters}`,
  });

  // ── a full decode, which catches corruption a probe will not ─────────
  stage(3, "Decoding every frame", 0);
  const sweep = await decodeSweep(ffmpegPath, outputPath, outputProbe.durationSec, signal, (fraction) =>
    stage(3, "Decoding every frame", fraction),
  );
  checks.push({
    id: "decode",
    label: "Decode sweep",
    status: sweep.ok ? "pass" : "fail",
    detail: sweep.ok ? "Decoded end to end with no errors" : sweep.detail,
  });

  // ── size ─────────────────────────────────────────────────────────────
  stage(4, "Comparing size");
  const outputSize = statSync(outputPath).size;
  const shrink = 1 - outputSize / source.size;
  checks.push({
    id: "size",
    label: "Size",
    status: shrink >= minShrinkRatio ? "pass" : "review",
    detail: `${(shrink * 100).toFixed(1)}% smaller — ${formatBytes(outputSize)} from ${formatBytes(source.size)}`,
  });

  // ── picture quality ──────────────────────────────────────────────────
  if (skipVmaf) {
    checks.push({ id: "vmaf", label: "VMAF", status: "skipped", detail: "Video stream was copied — nothing to compare." });
  } else {
    try {
      vmaf = await sampleVmaf(ffmpegPath, source, outputPath, vmafSampleSeconds, signal, (done, total) =>
        stage(5, `Measuring picture quality (window ${done} of ${total})`, done / total),
      );
      checks.push({
        id: "vmaf",
        label: "VMAF",
        status: vmaf === null ? "skipped" : vmaf >= vmafFloor ? "pass" : "review",
        detail: vmaf === null ? "Could not measure" : `${vmaf.toFixed(2)} mean, floor ${vmafFloor}`,
      });
    } catch (err) {
      checks.push({ id: "vmaf", label: "VMAF", status: "skipped", detail: `Could not measure: ${(err as Error).message}` });
    }
  }

  stage(STEPS, "Done");
  const failed = checks.some((c) => c.status === "fail");
  const review = checks.some((c) => c.status === "review");
  return { ok: !failed && !review, needsReview: !failed && review, checks, outputProbe, vmaf };
}

/**
 * Decode every frame and discard it, purely to surface errors.
 *
 * On a feature this is the longest step in verification, so it reports
 * progress rather than leaving the UI looking stalled.
 */
async function decodeSweep(
  ffmpegPath: string,
  path: string,
  durationSec: number | null,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      ["-hide_banner", "-nostdin", "-v", "error", "-xerror", "-progress", "pipe:1", "-nostats", "-i", path, "-f", "null", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
    });

    if (durationSec && onProgress) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.startsWith("out_time_us=")) return;
        const seconds = Number(line.slice("out_time_us=".length)) / 1e6;
        if (Number.isFinite(seconds)) onProgress(Math.min(1, seconds / durationSec));
      });
    } else {
      child.stdout.resume();
    }

    child.on("error", (err) => resolve({ ok: false, detail: err.message.slice(0, 200) }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const noise = stderr.trim();
      if (code === 0 && noise.length === 0) return resolve({ ok: true, detail: "" });
      resolve({ ok: false, detail: (noise.split("\n")[0] ?? `exit code ${code}`).slice(0, 200) });
    });
  });
}

/**
 * Mean VMAF over a few sampled windows rather than the whole film.
 *
 * A full-length comparison would cost as much as the encode. Three
 * windows spread across the running time catch a bad encode without that.
 */
async function sampleVmaf(
  ffmpegPath: string,
  source: Probe,
  outputPath: string,
  sampleSeconds: number,
  signal?: AbortSignal,
  onWindow?: (done: number, total: number) => void,
): Promise<number | null> {
  const duration = source.durationSec;
  if (!duration || duration <= 0) return null;

  const windows = 3;
  const window = Math.max(5, Math.min(sampleSeconds / windows, duration / windows));
  // Skip the first and last 5% — titles and credits are not representative.
  const usable = duration * 0.9;
  const offsets = Array.from({ length: windows }, (_, i) => duration * 0.05 + (usable / windows) * i);

  const scores: number[] = [];
  for (const [index, offset] of offsets.entries()) {
    onWindow?.(index + 1, offsets.length);
    const score = await vmafWindow(ffmpegPath, source.path, outputPath, offset, window, signal);
    if (score !== null) scores.push(score);
  }
  if (scores.length === 0) return null;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

async function vmafWindow(
  ffmpegPath: string,
  referencePath: string,
  distortedPath: string,
  offset: number,
  seconds: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const args = [
    "-hide_banner", "-nostdin", "-v", "info",
    "-ss", offset.toFixed(3), "-t", seconds.toFixed(3), "-i", distortedPath,
    "-ss", offset.toFixed(3), "-t", seconds.toFixed(3), "-i", referencePath,
    // Keep both streams on the same seek-relative timeline. Resetting each
    // to its own first frame can align different frames after a seek. Muxer
    // time bases also round timestamps differently (e.g. 1/90000 vs 1/24000):
    // framesync's default "lower or equal" then compares the preceding frame
    // for a difference of just a few microseconds. Nearest preserves timing
    // while pairing the actual corresponding pictures; it does not retime them.
    "-lavfi", "[0:v:0]settb=AVTB[dist];[1:v:0]settb=AVTB[ref];[dist][ref]libvmaf=ts_sync_mode=nearest",
    "-f", "null", "-",
  ];
  try {
    const { stderr } = await run(ffmpegPath, args, { maxBuffer: 8 * 1024 * 1024, signal });
    return parseVmaf(stderr);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    return stderr ? parseVmaf(stderr) : null;
  }
}

export function parseVmaf(stderr: string): number | null {
  const match = stderr.match(/VMAF score:\s*([\d.]+)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
