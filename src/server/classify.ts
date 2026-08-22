import type { Probe, Assessment, Chip, AudioTrack } from "../shared/types.ts";

/**
 * Video codecs worth re-encoding to HEVC, and roughly what fraction of the
 * source video bitrate an equal-quality HEVC encode tends to need.
 *
 * These are planning figures for the browse screen only. The real number for
 * a given file comes from the sample estimator before anything is queued.
 */
const VIDEO_REPLACE_RATIO: Record<string, number> = {
  h264: 0.5,
  mpeg2video: 0.35,
  vc1: 0.4,
  mpeg4: 0.35,
  msmpeg4v3: 0.3,
  wmv3: 0.35,
};

/** Already efficient — no video work unless the file is grossly overweight. */
const EFFICIENT_VIDEO = new Set(["hevc", "av1", "vp9"]);

/** Audio a basic Dolby Digital 5.1 chain will not direct-play. */
const AUDIO_REPLACE = new Set([
  "dts", "dts-hd", "dts-hd ma", "truehd", "flac",
  "pcm_s16le", "pcm_s24le", "pcm_bluray", "pcm_dvd", "mlp",
]);

/** Bitrate the replacement AC3 5.1 track is encoded at — the Dolby Digital ceiling. */
export const AC3_BITRATE = 640_000;

/** Hardware encoding takes over at 4K, where software x265 is not viable. */
export const HARDWARE_MIN_HEIGHT = 1440;

/**
 * Bits per pixel above which an already-HEVC file is still considered bloated.
 * A 1080p25 HEVC encode at 0.1 bpp is about 5 Mbps — generous already.
 */
const BLOATED_BPP = 0.12;

export function assess(probe: Probe): Assessment {
  const chips: Chip[] = [];
  const empty: Assessment = {
    videoWork: false, audioWork: false, encoder: null, bitsPerPixel: null,
    estimatedBytes: null, savingBytes: null, chips, blockedReason: null,
  };

  if (probe.error) {
    chips.push({ label: "UNREADABLE", tone: "bad", title: `ffprobe could not read this file: ${probe.error}` });
    return { ...empty, blockedReason: "ffprobe could not read this file." };
  }

  const video = probe.video;
  if (!video) {
    chips.push({ label: "NO VIDEO", tone: "note", title: "No video stream found — nothing to convert." });
    return { ...empty, blockedReason: "No video stream." };
  }

  // ── video ────────────────────────────────────────────────────────────
  const codec = video.codec.toLowerCase();
  const bpp = bitsPerPixel(video.bitrate, video.width, video.height, video.fps);
  const replaceRatio = VIDEO_REPLACE_RATIO[codec];
  const bloated = EFFICIENT_VIDEO.has(codec) && bpp !== null && bpp > BLOATED_BPP;
  const videoWork = replaceRatio !== undefined || bloated;

  if (replaceRatio !== undefined) {
    chips.push({ label: codecLabel(codec), tone: "bad", title: `${codecLabel(codec)} video — re-encoding to HEVC typically saves ${Math.round((1 - replaceRatio) * 100)}%.` });
  } else if (EFFICIENT_VIDEO.has(codec)) {
    chips.push({ label: codecLabel(codec), tone: "good", title: `${codecLabel(codec)} video — already an efficient codec.` });
  } else {
    chips.push({ label: codecLabel(codec), tone: "note", title: `${codecLabel(codec)} video.` });
  }
  if (bloated) {
    chips.push({ label: "BLOATED", tone: "warn", title: `${bpp!.toFixed(3)} bits per pixel — efficient codec, but encoded at a far higher bitrate than it needs.` });
  }

  const resolution = resolutionLabel(video.height);
  if (resolution) chips.push({ label: resolution, tone: "note", title: `${video.width}×${video.height}` });
  if (video.bitDepth && video.bitDepth >= 10) {
    chips.push({ label: `${video.bitDepth}BIT`, tone: "note", title: `${video.bitDepth}-bit video.` });
  }
  if (video.hdr) {
    chips.push({ label: video.hdr === "Dolby Vision" ? "DV" : video.hdr.toUpperCase(), tone: "note", title: `${video.hdr} — metadata is preserved, but check the result before accepting.` });
  }

  // ── audio ────────────────────────────────────────────────────────────
  const primary = primaryAudio(probe.audio);
  const audioWork = probe.audio.some((a) => AUDIO_REPLACE.has(a.codec.toLowerCase()));
  for (const chip of audioChips(probe.audio)) chips.push(chip);

  // ── things to leave alone ────────────────────────────────────────────
  let blockedReason: string | null = null;
  if (probe.audio.some((a) => a.hasAtmos)) {
    chips.push({ label: "ATMOS", tone: "warn", title: "Carries Atmos objects. The replace policy would discard them permanently, so this file is excluded unless you override it." });
    blockedReason = "Atmos objects would be discarded by the AC3 replace policy.";
  }
  if (video.hdr === "Dolby Vision") {
    blockedReason ??= "Dolby Vision metadata does not survive this pipeline reliably.";
  }

  // ── estimate ─────────────────────────────────────────────────────────
  const encoder = videoWork
    ? video.height >= HARDWARE_MIN_HEIGHT ? "hevc_videotoolbox" : "libx265"
    : null;

  const estimatedBytes = estimateBytes(probe, { videoWork, audioWork, encoder, replaceRatio, bloated });
  const savingBytes = estimatedBytes === null ? null : Math.max(0, probe.size - estimatedBytes);

  if (!videoWork && !audioWork) {
    chips.push({ label: "OK", tone: "good", title: "Efficient video and compatible audio — nothing to do." });
  }

  return { videoWork, audioWork, encoder, bitsPerPixel: bpp, estimatedBytes, savingBytes, chips, blockedReason };
}

export function bitsPerPixel(bitrate: number | null, width: number, height: number, fps: number | null): number | null {
  if (!bitrate || !width || !height || !fps) return null;
  const value = bitrate / (width * height * fps);
  return Number.isFinite(value) ? value : null;
}

/** The track a player would pick: most channels, tie-broken by stream order. */
export function primaryAudio(tracks: AudioTrack[]): AudioTrack | null {
  if (tracks.length === 0) return null;
  return tracks.reduce((best, t) => (t.channels > best.channels ? t : best), tracks[0]!);
}

interface EstimateInput {
  videoWork: boolean;
  audioWork: boolean;
  encoder: Assessment["encoder"];
  replaceRatio: number | undefined;
  bloated: boolean;
}

/**
 * Project the output size under the locked policy: HEVC video at the ratio
 * for its source codec, primary audio replaced with AC3 640k, every other
 * track passed through untouched.
 */
export function estimateBytes(probe: Probe, input: EstimateInput): number | null {
  const { durationSec, video } = probe;
  if (!durationSec || !video) return null;
  if (!input.videoWork && !input.audioWork) return probe.size;

  // Video
  let videoBitrate = video.bitrate;
  if (videoBitrate === null) return null;
  if (input.videoWork) {
    const ratio = input.replaceRatio ?? (input.bloated ? BLOATED_BPP / (bitsPerPixel(video.bitrate, video.width, video.height, video.fps) ?? 1) : 1);
    // Hardware HEVC needs roughly 30% more bitrate than x265 for equal quality.
    const hardwarePenalty = input.encoder === "hevc_videotoolbox" ? 1.3 : 1;
    videoBitrate = Math.round(videoBitrate * ratio * hardwarePenalty);
  }

  // Audio: primary becomes AC3 640k, the rest carry over as they are.
  const primary = primaryAudio(probe.audio);
  let audioBitrate = 0;
  for (const track of probe.audio) {
    if (primary && track.index === primary.index) {
      audioBitrate += AUDIO_REPLACE.has(track.codec.toLowerCase()) ? AC3_BITRATE : track.bitrate ?? AC3_BITRATE;
    } else {
      audioBitrate += track.bitrate ?? 128_000;
    }
  }

  // Subtitles and container overhead: small, but not nothing on a long file.
  const overhead = 0.01;
  const bytes = ((videoBitrate + audioBitrate) * durationSec / 8) * (1 + overhead);
  return Math.round(bytes);
}

function audioChips(tracks: AudioTrack[]): Chip[] {
  const seen = new Set<string>();
  const chips: Chip[] = [];
  for (const track of tracks) {
    const codec = track.codec.toLowerCase();
    const label = codecLabel(codec);
    if (seen.has(label)) continue;
    seen.add(label);
    if (AUDIO_REPLACE.has(codec)) {
      chips.push({ label, tone: "warn", title: `${label} audio — your Dolby Digital chain will not direct-play this. Replaced with AC3 640k 5.1.` });
    } else if (codec === "ac3" || codec === "eac3" || codec === "aac") {
      chips.push({ label, tone: "good", title: `${label} audio — direct-plays already.` });
    }
  }
  return chips;
}

function codecLabel(codec: string): string {
  const named: Record<string, string> = {
    h264: "H264", hevc: "HEVC", mpeg2video: "MPEG2", vc1: "VC1", mpeg4: "MPEG4",
    msmpeg4v3: "MSMPEG4", wmv3: "WMV3", av1: "AV1", vp9: "VP9",
    "dts-hd ma": "DTS-HD MA", "dts-hd": "DTS-HD", dts: "DTS", truehd: "TRUEHD",
    eac3: "EAC3", ac3: "AC3", aac: "AAC", flac: "FLAC", mlp: "MLP",
  };
  return named[codec] ?? (codec.startsWith("pcm") ? "PCM" : codec.toUpperCase());
}

function resolutionLabel(height: number): string | null {
  if (height >= 2000) return "4K";
  if (height >= 1000) return "1080P";
  if (height >= 700) return "720P";
  if (height > 0) return "SD";
  return null;
}
