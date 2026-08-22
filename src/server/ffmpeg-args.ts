import type { Probe, AudioTrack } from "../shared/types.ts";
import type { Preset } from "../shared/preset.ts";
import {
  AUDIO_REPLACE, HARDWARE_MIN_HEIGHT, primaryAudio, planFor,
  type Selection,
} from "../shared/estimate.ts";

export interface BuildInput {
  probe: Probe;
  selection: Selection;
  preset: Preset;
  outputPath: string;
}

export interface BuiltCommand {
  args: string[];
  encoder: "libx265" | "hevc_videotoolbox" | "copy";
  /** Output audio stream 0 — the one made default. */
  primaryAudioIndex: number | null;
  /** Set when the hardware path needs an explicit bitrate. */
  targetVideoBitrate: number | null;
  notes: string[];
}

export class BuildError extends Error {}

/**
 * Build the ffmpeg argument list for one job.
 *
 * Pure: it touches nothing and runs nothing, so the whole policy is testable
 * without encoding a frame.
 */
export function buildCommand(input: BuildInput): BuiltCommand {
  const { probe, selection, preset, outputPath } = input;
  const notes: string[] = [];

  if (!probe.video) throw new BuildError("No video stream to encode.");
  if (probe.error) throw new BuildError(`Refusing to encode an unreadable file: ${probe.error}`);

  const keptAudio = orderedAudio(probe, selection);
  if (probe.audio.length > 0 && keptAudio.length === 0) {
    throw new BuildError("At least one audio track must be kept.");
  }
  const keptSubs = probe.subtitles.filter((t) => selection.subtitles.includes(t.index));

  const plan = planFor(probe);
  const height = probe.video.height;
  const encoder = chooseEncoder(plan.videoWork, height, preset);

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    // Structured progress on stdout, so parsing never fights log formatting.
    "-progress", "pipe:1",
    "-nostats",
    "-i", probe.path,
  ];

  // ── stream mapping ───────────────────────────────────────────────────
  args.push("-map", `0:${probe.video.index}`);
  for (const track of keptAudio) args.push("-map", `0:${track.index}`);
  for (const track of keptSubs) args.push("-map", `0:${track.index}`);
  args.push("-map_metadata", "0", "-map_chapters", "0");

  // ── video ────────────────────────────────────────────────────────────
  let targetVideoBitrate: number | null = null;

  if (encoder === "copy") {
    args.push("-c:v", "copy");
    notes.push("Video stream copied — already an efficient codec at a sane bitrate.");
  } else if (encoder === "libx265") {
    args.push(
      "-c:v", "libx265",
      "-crf", String(preset.crf),
      "-preset", preset.x265Preset,
      "-pix_fmt", preset.tenBit ? "yuv420p10le" : "yuv420p",
      // Keep x265's own logging out of the progress stream.
      "-x265-params", "log-level=error",
    );
  } else {
    targetVideoBitrate = hardwareBitrate(probe, preset);
    args.push(
      "-c:v", "hevc_videotoolbox",
      // This ffmpeg build rejects "5M". Integers only.
      "-b:v", String(targetVideoBitrate),
      "-pix_fmt", preset.tenBit ? "p010le" : "nv12",
    );
    if (preset.tenBit) args.push("-profile:v", "main10");
    notes.push(
      `Hardware HEVC at ${(targetVideoBitrate / 1e6).toFixed(1)} Mbps. ` +
        `Quick Sync has no dependable constant-quality mode, so the VMAF gate is what holds quality here.`,
    );
  }

  if (preset.maxHeight !== null && height > preset.maxHeight) {
    // Even width and height, or the encoder refuses the frame size.
    args.push("-vf", `scale=-2:${preset.maxHeight}`);
    notes.push(`Downscaling ${height}p to ${preset.maxHeight}p — you asked for this explicitly.`);
  }

  if (probe.video.hdr) notes.push(`${probe.video.hdr} source — colour metadata is carried through by the container.`);

  // ── audio ────────────────────────────────────────────────────────────
  keptAudio.forEach((track, outputIndex) => {
    const needsReplacing = AUDIO_REPLACE.has(track.codec.toLowerCase());
    if (!needsReplacing) {
      args.push(`-c:a:${outputIndex}`, "copy");
      return;
    }
    args.push(`-c:a:${outputIndex}`, "ac3", `-b:a:${outputIndex}`, String(preset.ac3Bitrate));

    if (track.channels > 6) {
      // AC3 tops out at 5.1. ffmpeg's default fold leaves dialogue sitting too
      // low against the surrounds, so weight the merge explicitly instead.
      args.push(
        `-filter:a:${outputIndex}`,
        "pan=5.1|FL=FL|FR=FR|FC=FC|LFE=LFE|SL=0.707*SL+0.707*BL|SR=0.707*SR+0.707*BR",
      );
      notes.push(`Track ${track.index}: ${track.channels} channels downmixed to 5.1 with an explicit weighting.`);
    } else {
      args.push(`-ac:a:${outputIndex}`, String(Math.min(track.channels, 6)));
    }
  });

  // The kept primary leads and is the default, so players pick it without help.
  if (keptAudio.length > 0) {
    args.push("-disposition:a:0", "default");
    for (let i = 1; i < keptAudio.length; i++) args.push(`-disposition:a:${i}`, "0");
  }

  // ── subtitles ────────────────────────────────────────────────────────
  if (keptSubs.length > 0) args.push("-c:s", "copy");

  args.push("-y", outputPath);

  return {
    args,
    encoder,
    primaryAudioIndex: keptAudio[0]?.index ?? null,
    targetVideoBitrate,
    notes,
  };
}

/** Kept audio, primary first so it becomes output stream 0. */
function orderedAudio(probe: Probe, selection: Selection): AudioTrack[] {
  const kept = probe.audio.filter((t) => selection.audio.includes(t.index));
  const primary = primaryAudio(kept);
  if (!primary) return kept;
  return [primary, ...kept.filter((t) => t.index !== primary.index)];
}

function chooseEncoder(videoWork: boolean, height: number, preset: Preset): BuiltCommand["encoder"] {
  if (preset.forceEncoder) return preset.forceEncoder;
  // A resolution cap means re-encoding even if the codec is already fine.
  if (!videoWork && preset.maxHeight === null) return "copy";
  return height >= HARDWARE_MIN_HEIGHT ? "hevc_videotoolbox" : "libx265";
}

/**
 * Bitrate for the hardware path, which has no usable CRF equivalent.
 *
 * Derived from the source rather than a fixed ladder, so a lightly-encoded
 * source does not get inflated and a heavy one is not starved. The 1.3
 * multiplier is the measured cost of Quick Sync against x265 at equal quality.
 */
export function hardwareBitrate(probe: Probe, preset: Preset): number {
  const source = probe.video?.bitrate ?? 0;
  const plan = planFor(probe);
  const ratio = plan.replaceRatio ?? 0.6;
  const derived = Math.round(source * ratio * 1.3);

  // Floors and ceilings by resolution, so a bad probe cannot produce nonsense.
  const height = probe.video?.height ?? 1080;
  const floor = height >= HARDWARE_MIN_HEIGHT ? 8_000_000 : 2_000_000;
  const ceiling = height >= HARDWARE_MIN_HEIGHT ? 40_000_000 : 12_000_000;
  const clamped = Math.min(Math.max(derived, floor), ceiling);

  // CRF is inverted relative to bitrate: a lower CRF asks for more bits.
  const crfAdjustment = 1 + (20 - preset.crf) * 0.06;
  return Math.round(clamped * crfAdjustment);
}
