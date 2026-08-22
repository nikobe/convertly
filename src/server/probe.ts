import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { extname } from "node:path";
import type { Probe, VideoTrack, AudioTrack, SubtitleTrack } from "../shared/types.ts";

const run = promisify(execFile);

/** ffprobe can hang on a damaged file; never let one stall a scan. */
const PROBE_TIMEOUT_MS = 30_000;

interface FfStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  profile?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string }[];
}

export async function probeFile(ffprobePath: string, filePath: string): Promise<Probe> {
  const stat = statSync(filePath);
  const base: Probe = {
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    durationSec: null,
    container: extname(filePath).slice(1).toLowerCase() || null,
    video: null,
    audio: [],
    subtitles: [],
    chapters: 0,
    probedAt: Date.now(),
    error: null,
  };

  let parsed: { streams?: FfStream[]; format?: Record<string, unknown>; chapters?: unknown[] };
  try {
    const { stdout } = await run(
      ffprobePath,
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        filePath,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ...base, error: shortError(err) };
  }

  const streams = parsed.streams ?? [];
  const duration = Number(parsed.format?.duration);
  base.durationSec = Number.isFinite(duration) && duration > 0 ? duration : null;
  base.chapters = Array.isArray(parsed.chapters) ? parsed.chapters.length : 0;
  base.container = typeof parsed.format?.format_name === "string" ? parsed.format.format_name : base.container;

  base.video = pickVideo(streams);
  base.audio = streams.filter((s) => s.codec_type === "audio").map(toAudio);
  base.subtitles = streams.filter((s) => s.codec_type === "subtitle").map(toSubtitle);

  // ffprobe often omits per-stream video bitrate in Matroska. Derive it from
  // the container total minus what the audio tracks declare, which is close
  // enough for sizing decisions and clearly better than showing nothing.
  if (base.video && base.video.bitrate === null && base.durationSec) {
    const totalBits = base.size * 8;
    const audioBits = base.audio.reduce((sum, a) => sum + (a.bitrate ?? 0) * base.durationSec!, 0);
    const videoBits = totalBits - audioBits;
    if (videoBits > 0) base.video.bitrate = Math.round(videoBits / base.durationSec);
  }

  return base;
}

function pickVideo(streams: FfStream[]): VideoTrack | null {
  // Skip cover art and thumbnails, which appear as tiny mjpeg/png video streams.
  const real = streams.filter(
    (s) =>
      s.codec_type === "video" &&
      !s.disposition?.attached_pic &&
      s.codec_name !== "mjpeg" &&
      s.codec_name !== "png",
  );
  const s = real[0];
  if (!s) return null;

  return {
    index: s.index,
    codec: s.codec_name ?? "unknown",
    width: s.width ?? 0,
    height: s.height ?? 0,
    pixFmt: s.pix_fmt ?? null,
    bitDepth: bitDepth(s),
    fps: parseFps(s.avg_frame_rate),
    bitrate: toInt(s.bit_rate),
    hdr: detectHdr(s),
  };
}

function bitDepth(s: FfStream): number | null {
  const raw = toInt(s.bits_per_raw_sample);
  if (raw) return raw;
  if (!s.pix_fmt) return null;
  if (s.pix_fmt.includes("p10")) return 10;
  if (s.pix_fmt.includes("p12")) return 12;
  return 8;
}

function detectHdr(s: FfStream): string | null {
  const sideData = s.side_data_list?.map((d) => d.side_data_type ?? "") ?? [];
  if (sideData.some((t) => t.includes("Dolby Vision"))) return "Dolby Vision";
  if (sideData.some((t) => t.includes("HDR Dynamic Metadata"))) return "HDR10+";
  const depth = bitDepth(s);
  if (s.profile?.includes("Main 10") || (depth !== null && depth >= 10)) {
    // 10-bit alone is not HDR, but on HEVC it usually accompanies it. Callers
    // treat this as "check before converting" rather than a hard fact.
    return s.codec_name === "hevc" ? "HDR10" : null;
  }
  return null;
}

function toAudio(s: FfStream): AudioTrack {
  const codec = s.codec_name ?? "unknown";
  const profile = s.profile ?? "";
  return {
    index: s.index,
    codec: profile.includes("DTS-HD MA") ? "dts-hd ma" : profile.includes("DTS-HD") ? "dts-hd" : codec,
    channels: s.channels ?? 0,
    channelLayout: s.channel_layout ?? null,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
    bitrate: toInt(s.bit_rate),
    hasAtmos: /atmos/i.test(profile) || /atmos/i.test(s.tags?.title ?? ""),
    isDefault: Boolean(s.disposition?.default),
  };
}

function toSubtitle(s: FfStream): SubtitleTrack {
  return {
    index: s.index,
    codec: s.codec_name ?? "unknown",
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
    forced: Boolean(s.disposition?.forced),
  };
}

function parseFps(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const stderr = (err as { stderr?: string }).stderr;
  const text = (stderr && stderr.trim()) || message;
  return text.split("\n")[0]!.slice(0, 300);
}
