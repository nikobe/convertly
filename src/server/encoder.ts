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
    const { ffmpegPath, args, durationSec, onProgress, signal } = options;
    const started = Date.now();
    const samples: { at: number; outTime: number }[] = [];
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
      // Keep only the tail; a broken encode can produce megabytes of it.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
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
      const now = Date.now();
      samples.push({ at: now, outTime: outTimeSec });
      // A trailing window, so a throttled machine is reflected within a minute.
      while (samples.length > 2 && now - samples[0]!.at > 60_000) samples.shift();

      onProgress?.({
        fraction: durationSec ? Math.min(1, outTimeSec / durationSec) : null,
        outTimeSec,
        frame: Number(fields.get("frame") ?? 0),
        fps: Number(fields.get("fps") ?? 0),
        speed: parseSpeed(fields.get("speed")),
        etaSec: estimateEta(samples, durationSec, outTimeSec),
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

export function parseSpeed(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/x$/, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Seconds remaining, from throughput measured across the trailing window. */
export function estimateEta(
  samples: { at: number; outTime: number }[],
  durationSec: number | null,
  outTimeSec: number,
): number | null {
  if (!durationSec || samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const wallElapsed = (last.at - first.at) / 1000;
  const mediaEncoded = last.outTime - first.outTime;
  if (wallElapsed <= 0 || mediaEncoded <= 0) return null;
  const rate = mediaEncoded / wallElapsed;
  const remaining = Math.max(0, durationSec - outTimeSec);
  return Math.round(remaining / rate);
}
