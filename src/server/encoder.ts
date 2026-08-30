import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

export interface Progress {
  /** 0–1, or null when the source duration is unknown. */
  fraction: number | null;
  outTimeSec: number;
  frame: number;
  fps: number;
  /** Realtime multiple, measured — never taken from a benchmark table. */
  speed: number;
  /** Seconds remaining, from rolling measured throughput. */
  etaSec: number | null;
  outputBytes: number;
}

export interface EncodeOptions {
  ffmpegPath: string;
  args: string[];
  durationSec: number | null;
  /**
   * Video frames expected in the output.
   *
   * This, not out_time, is what progress is measured against. out_time is the
   * muxer's furthest-written timestamp, and a stream-copied audio track is
   * written far ahead of the encode: on a 2-minute file it reported 64s —
   * 53% — after eight frames. frame= only counts encoded video.
   */
  totalFrames: number | null;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

export interface EncodeResult {
  ok: boolean;
  exitCode: number | null;
  /** Set when the caller aborted, as distinct from ffmpeg failing. */
  cancelled: boolean;
  stderr: string;
  elapsedSec: number;
}

/**
 * Run one ffmpeg encode, reporting progress as it goes.
 *
 * ETA comes from throughput measured on this job over a trailing window, not
 * from a static table: the target host thermally throttles across a long encode, so
 * a rate sampled in the first minute is a promise it cannot keep.
 */
export class Encode {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private paused = false;

  async run(options: EncodeOptions): Promise<EncodeResult> {
    const { ffmpegPath, args, durationSec, totalFrames, onProgress, signal } = options;
    const started = Date.now();
    const samples: { at: number; frame: number }[] = [];
    let stderr = "";
    let cancelled = false;

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    const abort = () => {
      cancelled = true;
      // Resume first, or a stopped process never sees the kill.
      if (this.paused) this.resume();
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      // Keep the cause as well as the ending; FFmpeg often finishes with only
      // "Nothing was written" after explaining the actual failure at the top.
      if (stderr.length > 64_000) {
        stderr = stderr.slice(0, 31_900) + "\n[FFmpeg log truncated]\n" + stderr.slice(-31_900);
      }
    });

    const fields = new Map<string, string>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const split = line.indexOf("=");
      if (split === -1) return;
      const key = line.slice(0, split).trim();
      const value = line.slice(split + 1).trim();
      fields.set(key, value);

      // ffmpeg emits a block per interval, terminated by "progress=".
      if (key !== "progress") return;

      const outTimeSec = Number(fields.get("out_time_us") ?? 0) / 1e6;
      const frame = Number(fields.get("frame") ?? 0);
      const now = Date.now();
      samples.push({ at: now, frame });
      // A trailing window: long enough to ride over x265's bursty out_time
      // reporting, short enough to still reflect thermal throttling, which
      // happens over minutes rather than seconds.
      while (samples.length > 2 && now - samples[0]!.at > ETA_WINDOW_MS) samples.shift();

      onProgress?.({
        fraction: totalFrames && totalFrames > 0 ? Math.min(1, frame / totalFrames) : null,
        outTimeSec,
        frame,
        fps: Number(fields.get("fps") ?? 0),
        speed: parseSpeed(fields.get("speed")),
        etaSec: estimateEta(samples, totalFrames, frame),
        outputBytes: Number(fields.get("total_size") ?? 0),
      });
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    signal?.removeEventListener("abort", abort);
    this.child = null;
    lines.close();

    return {
      ok: exitCode === 0 && !cancelled,
      exitCode,
      cancelled,
      stderr: stderr.trim(),
      elapsedSec: (Date.now() - started) / 1000,
    };
  }

  /**
   * Suspend the encode. Costs nothing and loses nothing, which is what makes
   * the playback-aware and thermal governors cheap enough to fire often.
   */
  pause(): boolean {
    if (!this.child || this.paused) return false;
    this.paused = this.child.kill("SIGSTOP");
    return this.paused;
  }

  resume(): boolean {
    if (!this.child || !this.paused) return false;
    const ok = this.child.kill("SIGCONT");
    if (ok) this.paused = false;
    return ok;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}

/** A bounded, useful queue message, instead of FFmpeg's generic final line. */
export function summarizeFfmpegError(stderr: string, exitCode: number | null): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return `exit code ${exitCode ?? "unknown"}`;
  return lines.slice(0, 3).join("\n").slice(0, 1_500);
}

/** Trailing window used to measure throughput. */
export const ETA_WINDOW_MS = 120_000;
/** Below this the window is too short to give an honest rate. */
export const ETA_MIN_SPAN_MS = 20_000;

export function parseSpeed(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/x$/, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Seconds remaining, from frames-per-second measured across the trailing
 * window. Frames, not out_time: see EncodeOptions.totalFrames.
 */
export function estimateEta(
  samples: { at: number; frame: number }[],
  totalFrames: number | null,
  frame: number,
): number | null {
  if (!totalFrames || totalFrames <= 0 || samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (last.at - first.at < ETA_MIN_SPAN_MS) return null;
  const wallElapsed = (last.at - first.at) / 1000;
  const framesEncoded = last.frame - first.frame;
  if (wallElapsed <= 0 || framesEncoded <= 0) return null;
  const rate = framesEncoded / wallElapsed;
  const remaining = Math.max(0, totalFrames - frame);
  return Math.round(remaining / rate);
}
