import type { Probe, Assessment, Chip, AudioTrack, Conversion } from "../shared/types.ts";
import {
  AUDIO_REPLACE, EFFICIENT_VIDEO, PREFERRED_LANGUAGES,
  planFor, primaryAudio, estimateBytes, keepEverything, subtitleBitrate,
  type Selection,
} from "../shared/estimate.ts";

export { primaryAudio, estimateBytes, planFor };
export { AC3_BITRATE, HARDWARE_MIN_HEIGHT, bitsPerPixel } from "../shared/estimate.ts";

/** Above this, the extra language tracks are worth surfacing as removable. */
const MANY_AUDIO_TRACKS = 3;

export function assess(probe: Probe, selection?: Selection, conversion?: Conversion | null): Assessment {
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

  const plan = planFor(probe);
  const codec = video.codec.toLowerCase();

  // Our own output is 10-bit HEVC, and on grainy material that lands above the
  // bits-per-pixel threshold. Without this the app offers to convert the file
  // it just produced, forever.
  const alreadyConverted = Boolean(conversion);
  if (alreadyConverted) {
    plan.videoWork = false;
    plan.audioWork = false;
    plan.encoder = null;
    plan.bloated = false;
  }

  // ── video ────────────────────────────────────────────────────────────
  if (plan.replaceRatio !== undefined) {
    chips.push({ label: codecLabel(codec), tone: "bad", title: `${codecLabel(codec)} video — re-encoding to HEVC typically saves ${Math.round((1 - plan.replaceRatio) * 100)}%.` });
  } else if (EFFICIENT_VIDEO.has(codec)) {
    chips.push({ label: codecLabel(codec), tone: "good", title: `${codecLabel(codec)} video — already an efficient codec.` });
  } else {
    chips.push({ label: codecLabel(codec), tone: "note", title: `${codecLabel(codec)} video.` });
  }
  if (alreadyConverted && conversion) {
    const saved = conversion.originalSize - conversion.newSize;
    chips.push({
      label: "CONVERTED",
      tone: "good",
      title:
        `Converted by Convertly on ${new Date(conversion.convertedAt).toLocaleDateString()} — ` +
        `${(saved / 1e9).toFixed(2)} GB saved with ${conversion.encoder}` +
        `${conversion.vmaf ? `, VMAF ${conversion.vmaf.toFixed(1)}` : ""}. ` +
        `The original is in quarantine.`,
    });
  }
  if (plan.bloated) {
    chips.push({ label: "BLOATED", tone: "warn", title: `${plan.bitsPerPixel!.toFixed(3)} bits per pixel — an efficient codec, but encoded at a far higher bitrate than it needs.` });
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
  for (const chip of audioChips(probe.audio)) chips.push(chip);

  if (probe.audio.length > MANY_AUDIO_TRACKS && probe.durationSec) {
    const spareBits = probe.audio
      .filter((t) => !primary || t.index !== primary.index)
      .reduce((sum, t) => sum + (t.bitrate ?? 0), 0);
    const spareBytes = (spareBits * probe.durationSec) / 8;
    const kept = primary
      ? `${primary.language ?? "untagged"} ${primary.channels}ch ${primary.codec.toUpperCase()}`
      : "none";
    chips.push({
      label: `${probe.audio.length} AUDIO`,
      tone: "warn",
      title:
        `${probe.audio.length} audio tracks. Keeping ${kept} and dropping the rest saves about ` +
        `${(spareBytes / 1e9).toFixed(2)} GB — often more than the video re-encode itself. ` +
        `Open the file to choose which tracks to keep.`,
    });
  }

  if (probe.subtitles.length > 6) {
    const bits = probe.subtitles.reduce((sum, t) => sum + subtitleBitrate(t), 0);
    chips.push({
      label: `${probe.subtitles.length} SUBS`,
      tone: "note",
      title:
        `${probe.subtitles.length} subtitle tracks, roughly ` +
        `${(((bits * (probe.durationSec ?? 0)) / 8) / 1e6).toFixed(0)} MB. Open the file to trim them.`,
    });
  }

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
  const chosen = selection ?? keepEverything(probe);
  const estimatedBytes = estimateBytes(probe, plan, chosen);
  const savingBytes = estimatedBytes === null ? null : Math.max(0, probe.size - estimatedBytes);

  if (!plan.videoWork && !plan.audioWork && !alreadyConverted) {
    chips.push({ label: "OK", tone: "good", title: "Efficient video and compatible audio — nothing to do." });
  }

  return {
    videoWork: plan.videoWork,
    audioWork: plan.audioWork,
    encoder: plan.encoder,
    bitsPerPixel: plan.bitsPerPixel,
    estimatedBytes,
    savingBytes,
    chips,
    blockedReason,
  };
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

export function codecLabel(codec: string): string {
  const named: Record<string, string> = {
    h264: "H264", hevc: "HEVC", mpeg2video: "MPEG2", vc1: "VC1", mpeg4: "MPEG4",
    msmpeg4v3: "MSMPEG4", wmv3: "WMV3", av1: "AV1", vp9: "VP9",
    "dts-hd ma": "DTS-HD MA", "dts-hd": "DTS-HD", dts: "DTS", truehd: "TRUEHD",
    eac3: "EAC3", ac3: "AC3", aac: "AAC", flac: "FLAC", mlp: "MLP",
    hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VOBSUB", subrip: "SRT", ass: "ASS", mov_text: "TX3G",
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

export { PREFERRED_LANGUAGES };
