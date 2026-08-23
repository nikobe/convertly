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

/**
 * Audio that causes actual trouble downstream and is worth re-encoding.
 *
 * Deliberately narrow. Dolby Digital Plus and Atmos are left alone: the
 * playback chain here decodes and downmixes them without complaint, and an
 * added AC3 track costs ~576 MB on a two-hour film for no benefit. DTS is the
 * family that misbehaves, and lossless formats are simply enormous.
 */
export const AUDIO_REPLACE = new Set([
  "dts", "dts-hd", "dts-hd ma", "truehd", "flac",
  "pcm_s16le", "pcm_s24le", "pcm_bluray", "pcm_dvd", "mlp",
]);

/** The Dolby Digital ceiling, for a full 5.1 track. */
export const AC3_BITRATE = 640_000;

/** Channels beyond this are downmixed: the playback chain here is 5.1. */
export const MAX_CHANNELS = 6;

/**
 * AC3 bitrate for a given channel count.
 *
 * 640k is the 5.1 figure; spending it on a stereo track wastes most of it.
 * Nothing is ever upmixed, so a 2.0 source stays 2.0.
 */
export function ac3BitrateFor(channels: number, ceiling = AC3_BITRATE): number {
  if (channels >= 6) return ceiling;
  if (channels >= 3) return Math.min(448_000, ceiling);
  if (channels === 2) return Math.min(224_000, ceiling);
  return Math.min(128_000, ceiling);
}

/** Output channel count: capped at 5.1, never increased. */
export function outputChannels(channels: number): number {
  return Math.min(Math.max(channels, 1), MAX_CHANNELS);
}

export type ResolutionClass = "SD" | "720p" | "1080p" | "4K";

/**
 * Which resolution tier a frame belongs to.
 *
 * Height alone is wrong: film is letterboxed, so a 1080p scope transfer is
 * 1920x800 and a 2:1 one is 1920x960. Judging by height called those 720p,
 * and — far worse — would have routed a 4K scope master to software x265,
 * which is a ten-hour job on the target host. Width is the reliable signal, with
 * height as a fallback for anything unusually tall.
 */
export function resolutionClass(width: number, height: number): ResolutionClass {
  if (width >= 3000 || height >= 1700) return "4K";
  if (width >= 1700 || height >= 900) return "1080p";
  if (width >= 1100 || height >= 620) return "720p";
  return "SD";
}

/** Hardware encoding takes over at 4K, where software x265 is not viable. */
export function usesHardware(width: number, height: number): boolean {
  return resolutionClass(width, height) === "4K";
}

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
/**
 * Whether this track gets re-encoded to AC3 5.1.
 *
 * Three reasons to touch a track, and Atmos overrides all of them because the
 * objects cannot be recovered and this chain plays them fine:
 *
 *  - the codec misbehaves downstream (the DTS family)
 *  - it is lossless, and therefore simply enormous
 *  - it carries more than 5.1, which is channels this chain cannot use and
 *    where the default fold buries dialogue
 *
 * A stereo track that is none of those is left exactly as it is. Nothing is
 * ever upmixed.
 */
export function shouldReplaceAudio(track: AudioTrack): boolean {
  if (track.hasAtmos) return false;
  if (AUDIO_REPLACE.has(track.codec.toLowerCase())) return true;
  return track.channels > MAX_CHANNELS;
}

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
  audioPolicy: "replace" | "add";
  atmos: boolean;
  encoder: "libx265" | "hevc_videotoolbox" | null;
  replaceRatio: number | undefined;
  bloated: boolean;
  bitsPerPixel: number | null;
}

/** What the locked policy would do to this file, before any track choices. */
export function planFor(probe: Probe): Plan {
  const video = probe.video;
  if (!video) {
    return {
      videoWork: false, audioWork: false, audioPolicy: "replace", atmos: false,
      encoder: null, replaceRatio: undefined, bloated: false, bitsPerPixel: null,
    };
  }
  const codec = video.codec.toLowerCase();
  const bpp = bitsPerPixel(video.bitrate, video.width, video.height, video.fps);
  const replaceRatio = VIDEO_REPLACE_RATIO[codec];
  const bloated = EFFICIENT_VIDEO.has(codec) && bpp !== null && bpp > BLOATED_BPP;
  const videoWork = replaceRatio !== undefined || bloated;
  const atmos = probe.audio.some((a) => a.hasAtmos);
  const audioWork = probe.audio.some(shouldReplaceAudio);

  return {
    videoWork,
    audioPolicy: "replace",
    atmos,
    audioWork,
    encoder: videoWork ? (usesHardware(video.width, video.height) ? "hevc_videotoolbox" : "libx265") : null,
    replaceRatio,
    bloated,
    bitsPerPixel: bpp,
  };
}

/**
 * How much bitrate a given CRF asks for, relative to the CRF 20 baseline the
 * ratios above were derived at.
 *
 * The rule of thumb is that six CRF steps roughly double or halve the
 * bitrate. Approximate, but it has to be here or the quality control would
 * move a slider without moving the projected size.
 */
export function crfFactor(crf: number): number {
  return Math.pow(2, (20 - crf) / 6);
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
export function estimateBytes(
  probe: Probe,
  plan: Plan,
  selection: Selection,
  options: { crf?: number; maxHeight?: number | null } = {},
): number | null {
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
    const quality = crfFactor(options.crf ?? 20);
    videoBitrate = Math.round(videoBitrate * ratio * hardwarePenalty * quality);
  }

  // A resolution cap cuts bitrate roughly with pixel count, discounted because
  // a downscale is easier to encode than the pixel ratio alone suggests.
  const cap = options.maxHeight ?? null;
  if (cap && video.height > cap) {
    const pixelRatio = (cap * cap) / (video.height * video.height);
    videoBitrate = Math.round(videoBitrate * Math.pow(pixelRatio, 0.75));
  }

  const primary = primaryAudio(keptAudio);
  let audioBitrate = 0;
  for (const track of keptAudio) {
    const isPrimary = primary && track.index === primary.index;
    if (isPrimary && plan.audioPolicy === "add") {
      // Both survive: the original untouched, plus a new AC3 track.
      audioBitrate += (track.bitrate ?? 640_000) + AC3_BITRATE;
    } else if (shouldReplaceAudio(track)) {
      audioBitrate += ac3BitrateFor(outputChannels(track.channels));
    } else {
      audioBitrate += track.bitrate ?? (isPrimary ? AC3_BITRATE : 128_000);
    }
  }

  const subtitleBits = keptSubs.reduce((sum, t) => sum + subtitleBitrate(t), 0);

  const overhead = 0.005;
  const bytes = ((videoBitrate + audioBitrate + subtitleBits) * durationSec / 8) * (1 + overhead);
  return Math.round(bytes);
}
