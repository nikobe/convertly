/**
 * Sizing model shared by the server's assessment and the client's live
 * recalculation as you include or exclude tracks. Both must agree, so it
 * lives here rather than being implemented twice.
 */
import type { Probe, AudioTrack, SubtitleTrack } from "./types.ts";

/** Source codec -> fraction of its bitrate an equal-quality HEVC encode needs. */
export const VIDEO_REPLACE_RATIO: Record<string, number> = {
  h264: 0.5,
  mpeg2video: 0.35,
  vc1: 0.4,
  mpeg4: 0.35,
  msmpeg4v3: 0.3,
  wmv3: 0.35,
};

/** Already efficient — no video work unless the file is grossly overweight. */
export const EFFICIENT_VIDEO = new Set(["hevc", "av1", "vp9"]);

/** Audio a basic Dolby Digital 5.1 chain will not direct-play. */
export const AUDIO_REPLACE = new Set([
  "dts", "dts-hd", "dts-hd ma", "truehd", "flac",
  "pcm_s16le", "pcm_s24le", "pcm_bluray", "pcm_dvd", "mlp",
]);

/** The Dolby Digital ceiling, and what a replaced track is encoded at. */
export const AC3_BITRATE = 640_000;

/** Hardware encoding takes over at 4K, where software x265 is not viable. */
export const HARDWARE_MIN_HEIGHT = 1440;

/** Bits per pixel above which an already-efficient file is still bloated. */
export const BLOATED_BPP = 0.12;

/** Languages treated as "yours" when choosing which track to keep. */
export const PREFERRED_LANGUAGES = new Set(["eng", "en"]);

/** Tags meaning "nobody said" — better than a foreign dub, worse than a match. */
const UNTAGGED = new Set(["und", "unk", ""]);

/**
 * ffprobe reports no bitrate for subtitles, so these are rough constants by
 * kind. Image subtitles are the ones big enough to matter when a release
 * carries a dozen of them.
 */
const SUBTITLE_BITRATE: Record<string, number> = {
  hdmv_pgs_subtitle: 25_000,
  dvd_subtitle: 12_000,
  dvb_subtitle: 12_000,
};
const TEXT_SUBTITLE_BITRATE = 200;

export function subtitleBitrate(track: SubtitleTrack): number {
  return SUBTITLE_BITRATE[track.codec.toLowerCase()] ?? TEXT_SUBTITLE_BITRATE;
}

export function bitsPerPixel(bitrate: number | null, width: number, height: number, fps: number | null): number | null {
  if (!bitrate || !width || !height || !fps) return null;
  const value = bitrate / (width * height * fps);
  return Number.isFinite(value) ? value : null;
}

/**
 * The track worth keeping and re-encoding.
 *
 * Channel count alone is not enough: a release with eight foreign-language 5.1 dubs and
 * one English stereo would otherwise have a dub chosen. An explicit language
 * match wins first, then an untagged track (on a foreign release the untagged
 * 5.1 is usually itself a dub), then channels, then the default flag.
 */
export function primaryAudio(tracks: AudioTrack[]): AudioTrack | null {
  if (tracks.length === 0) return null;
  return tracks.reduce((best, t) => (audioScore(t) > audioScore(best) ? t : best), tracks[0]!);
}

function audioScore(t: AudioTrack): number {
  const language = t.language?.toLowerCase() ?? "und";
  let value = 0;
  if (PREFERRED_LANGUAGES.has(language)) value += 2000;
  else if (UNTAGGED.has(language)) value += 1000;
  value += Math.min(t.channels, 8) * 10;
  if (t.isDefault) value += 5;
  return value;
}

export interface Plan {
  videoWork: boolean;
  audioWork: boolean;
  encoder: "libx265" | "hevc_videotoolbox" | null;
  replaceRatio: number | undefined;
  bloated: boolean;
  bitsPerPixel: number | null;
}

/** What the locked policy would do to this file, before any track choices. */
export function planFor(probe: Probe): Plan {
  const video = probe.video;
  if (!video) {
    return { videoWork: false, audioWork: false, encoder: null, replaceRatio: undefined, bloated: false, bitsPerPixel: null };
  }
  const codec = video.codec.toLowerCase();
  const bpp = bitsPerPixel(video.bitrate, video.width, video.height, video.fps);
  const replaceRatio = VIDEO_REPLACE_RATIO[codec];
  const bloated = EFFICIENT_VIDEO.has(codec) && bpp !== null && bpp > BLOATED_BPP;
  const videoWork = replaceRatio !== undefined || bloated;
  const audioWork = probe.audio.some((a) => AUDIO_REPLACE.has(a.codec.toLowerCase()));

  return {
    videoWork,
    audioWork,
    encoder: videoWork ? (video.height >= HARDWARE_MIN_HEIGHT ? "hevc_videotoolbox" : "libx265") : null,
    replaceRatio,
    bloated,
    bitsPerPixel: bpp,
  };
}

/** Which tracks survive. Stream indexes, matching Probe.audio/subtitles. */
export interface Selection {
  audio: number[];
  subtitles: number[];
}

/** Everything kept — the safe default, and what the browse listing assumes. */
export function keepEverything(probe: Probe): Selection {
  return {
    audio: probe.audio.map((t) => t.index),
    subtitles: probe.subtitles.map((t) => t.index),
  };
}

/**
 * Project the output size: HEVC video at the ratio for its source codec, the
 * primary audio track re-encoded to AC3 640k if the target chain can't play it,
 * every other kept track passed through untouched, excluded tracks gone.
 */
export function estimateBytes(probe: Probe, plan: Plan, selection: Selection): number | null {
  const { durationSec, video } = probe;
  if (!durationSec || !video) return null;

  const keptAudio = probe.audio.filter((t) => selection.audio.includes(t.index));
  const keptSubs = probe.subtitles.filter((t) => selection.subtitles.includes(t.index));
  const droppedNothing =
    keptAudio.length === probe.audio.length && keptSubs.length === probe.subtitles.length;

  if (!plan.videoWork && !plan.audioWork && droppedNothing) return probe.size;

  let videoBitrate = video.bitrate;
  if (videoBitrate === null) return null;
  if (plan.videoWork) {
    const ratio =
      plan.replaceRatio ??
      (plan.bloated ? BLOATED_BPP / (plan.bitsPerPixel ?? 1) : 1);
    // Hardware HEVC needs roughly 30% more bitrate than x265 for equal quality.
    const hardwarePenalty = plan.encoder === "hevc_videotoolbox" ? 1.3 : 1;
    videoBitrate = Math.round(videoBitrate * ratio * hardwarePenalty);
  }

  const primary = primaryAudio(keptAudio);
  let audioBitrate = 0;
  for (const track of keptAudio) {
    if (primary && track.index === primary.index) {
      audioBitrate += AUDIO_REPLACE.has(track.codec.toLowerCase()) ? AC3_BITRATE : track.bitrate ?? AC3_BITRATE;
    } else {
      audioBitrate += track.bitrate ?? 128_000;
    }
  }

  const subtitleBits = keptSubs.reduce((sum, t) => sum + subtitleBitrate(t), 0);

  const overhead = 0.005;
  const bytes = ((videoBitrate + audioBitrate + subtitleBits) * durationSec / 8) * (1 + overhead);
  return Math.round(bytes);
}
