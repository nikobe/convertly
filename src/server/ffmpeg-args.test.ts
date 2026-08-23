import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, hardwareBitrate, BuildError } from "./ffmpeg-args.ts";
import { keepEverything } from "../shared/estimate.ts";
import { DEFAULT_PRESET, type Preset } from "../shared/preset.ts";
import type { Probe, AudioTrack, SubtitleTrack } from "../shared/types.ts";

function audio(over: Partial<AudioTrack> = {}): AudioTrack {
  return {
    index: 1, codec: "dts", channels: 6, channelLayout: "5.1", language: "eng",
    title: null, bitrate: 1_500_000, hasAtmos: false, isDefault: true, ...over,
  };
}
function sub(over: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return { index: 10, codec: "subrip", language: "eng", title: null, forced: false, ...over };
}
function probe(over: Partial<Probe> = {}): Probe {
  return {
    path: "/m/film.mkv", size: 24e9, mtimeMs: 1, durationSec: 7200, container: "matroska",
    chapters: 12, probedAt: 0, error: null, subtitles: [sub()],
    video: { index: 0, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 25e6, hdr: null, colorTransfer: null },
    audio: [audio()],
    ...over,
  };
}
const build = (p: Probe, preset: Preset = DEFAULT_PRESET, selection = keepEverything(p)) =>
  buildCommand({ probe: p, selection, preset, outputPath: "/m/.convertly-tmp/out.mkv" });

/** Value following a flag, e.g. arg(args, "-crf") -> "20". */
function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("1080p h264 uses software x265 at the preset's CRF", () => {
  const { args, encoder } = build(probe());
  assert.equal(encoder, "libx265");
  assert.equal(arg(args, "-c:v"), "libx265");
  assert.equal(arg(args, "-crf"), "20");
  assert.equal(arg(args, "-preset"), "medium");
  assert.equal(arg(args, "-pix_fmt"), "yuv420p10le");
});

test("4K uses the hardware encoder", () => {
  const p = probe({ video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 60e6, hdr: null, colorTransfer: null } });
  const { args, encoder } = build(p);
  assert.equal(encoder, "hevc_videotoolbox");
  assert.equal(arg(args, "-pix_fmt"), "p010le");
  assert.equal(arg(args, "-profile:v"), "main10");
});

test("bitrates are emitted as integers — this ffmpeg build rejects 5M", () => {
  const p = probe({ video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 60e6, hdr: null, colorTransfer: null } });
  const { args } = build(p);
  const bv = arg(args, "-b:v")!;
  assert.match(bv, /^\d+$/, `-b:v must be a plain integer, got ${bv}`);
  for (const a of args) assert.doesNotMatch(a, /^\d+(\.\d+)?[KMG]$/i, `no SI-suffixed number may reach ffmpeg: ${a}`);
});

test("audio bitrate is also a plain integer", () => {
  const { args } = build(probe());
  assert.match(arg(args, "-b:a:0")!, /^\d+$/);
});

test("DTS becomes AC3 at the Dolby Digital ceiling", () => {
  const { args } = build(probe());
  assert.equal(arg(args, "-c:a:0"), "ac3");
  assert.equal(arg(args, "-b:a:0"), "640000");
});

test("already-compatible audio is copied, not re-encoded", () => {
  const { args } = build(probe({ audio: [audio({ codec: "ac3", bitrate: 640_000 })] }));
  assert.equal(arg(args, "-c:a:0"), "copy");
  assert.ok(!args.includes("-b:a:0"), "must not set a bitrate on a copied stream");
});

test("7.1 is downmixed with an explicit weighting, not ffmpeg's default fold", () => {
  const { args } = build(probe({ audio: [audio({ channels: 8, channelLayout: "7.1" })] }));
  const filter = arg(args, "-filter:a:0")!;
  assert.match(filter, /^pan=5\.1\|/);
  assert.match(filter, /FC=FC/, "the centre channel must survive intact or dialogue drops");
  assert.match(filter, /SL=0\.707\*SL\+0\.707\*BL/);
});

test("the kept primary track leads and is marked default", () => {
  const dub = audio({ index: 1, codec: "ac3", channels: 6, language: "rus" });
  const english = audio({ index: 2, codec: "ac3", channels: 2, language: "eng" });
  const p = probe({ audio: [dub, english] });
  const { args, primaryAudioIndex } = build(p);
  assert.equal(primaryAudioIndex, 2, "English should lead even though it is narrower");
  const maps = args.reduce<string[]>((acc, a, i) => (a === "-map" ? [...acc, args[i + 1]!] : acc), []);
  assert.deepEqual(maps, ["0:0", "0:2", "0:1", "0:10"]);
  assert.equal(arg(args, "-disposition:a:0"), "default");
  assert.equal(arg(args, "-disposition:a:1"), "0");
});

test("dropped tracks are not mapped", () => {
  const p = probe({ audio: [audio({ index: 1 }), audio({ index: 2, language: "rus" })], subtitles: [sub({ index: 10 }), sub({ index: 11, language: "rus" })] });
  const { args } = build(p, DEFAULT_PRESET, { audio: [1], subtitles: [10] });
  const maps = args.reduce<string[]>((acc, a, i) => (a === "-map" ? [...acc, args[i + 1]!] : acc), []);
  assert.deepEqual(maps, ["0:0", "0:1", "0:10"]);
});

test("chapters and metadata are always carried over", () => {
  const { args } = build(probe());
  assert.equal(arg(args, "-map_chapters"), "0");
  assert.equal(arg(args, "-map_metadata"), "0");
});

test("an efficient file with compatible audio copies the video stream", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 4e6, hdr: null, colorTransfer: null },
    audio: [audio({ codec: "eac3", bitrate: 768_000 })],
  });
  const { encoder, args } = build(p);
  assert.equal(encoder, "copy");
  assert.equal(arg(args, "-c:v"), "copy");
});

test("resolution is untouched unless a cap is set deliberately", () => {
  assert.ok(!build(probe()).args.includes("-vf"));
  const capped = build(probe(), { ...DEFAULT_PRESET, maxHeight: 720 });
  assert.equal(arg(capped.args, "-vf"), "scale=-2:720");
});

test("a cap forces a re-encode even when the codec is already fine", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 4e6, hdr: null, colorTransfer: null },
    audio: [audio({ codec: "eac3" })],
  });
  assert.equal(build(p, { ...DEFAULT_PRESET, maxHeight: 720 }).encoder, "libx265");
});

test("progress is machine-readable and stdin is closed", () => {
  const { args } = build(probe());
  assert.equal(arg(args, "-progress"), "pipe:1");
  assert.ok(args.includes("-nostdin"), "a stray prompt must never block a queue overnight");
  assert.ok(args.includes("-nostats"));
});

test("refuses to encode an unreadable file", () => {
  assert.throws(() => build(probe({ error: "Invalid data" })), BuildError);
});

test("refuses to drop every audio track", () => {
  assert.throws(() => build(probe(), DEFAULT_PRESET, { audio: [], subtitles: [] }), BuildError);
});

test("hardware bitrate stays inside sane bounds", () => {
  const tiny = probe({ video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 1e6, hdr: null, colorTransfer: null } });
  assert.ok(hardwareBitrate(tiny, DEFAULT_PRESET) >= 8_000_000, "floor protects against a bad probe");
  const huge = probe({ video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 400e6, hdr: null, colorTransfer: null } });
  assert.ok(hardwareBitrate(huge, DEFAULT_PRESET) <= 40_000_000 * 1.01, "ceiling protects the disk");
});

test("a lower CRF asks the hardware encoder for more bits", () => {
  const p = probe({ video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 30e6, hdr: null, colorTransfer: null } });
  assert.ok(hardwareBitrate(p, { ...DEFAULT_PRESET, crf: 16 }) > hardwareBitrate(p, { ...DEFAULT_PRESET, crf: 24 }));
});

test("the output path is the last argument and overwrite is explicit", () => {
  const { args } = build(probe());
  assert.equal(args.at(-1), "/m/.convertly-tmp/out.mkv");
  assert.equal(args.at(-2), "-y");
});

test("an Atmos track is copied untouched, and nothing is added beside it", () => {
  const p = probe({ audio: [audio({ codec: "eac3", channels: 6, bitrate: 768_000, hasAtmos: true })] });
  const { args, expectedAudioStreams } = build(p);

  const maps = args.reduce<string[]>((acc, a, i) => (a === "-map" ? [...acc, args[i + 1]!] : acc), []);
  assert.deepEqual(maps, ["0:0", "0:1", "0:10"], "the source track is mapped once");
  assert.equal(arg(args, "-c:a:0"), "copy", "Atmos objects cannot be recovered, so never re-encode them");
  assert.equal(expectedAudioStreams, 1, "an added AC3 track costs ~576 MB on a 2h film for no benefit here");
  assert.equal(args.includes("-c:a:1"), false);
});

test("TrueHD Atmos is copied even though plain TrueHD would be replaced", () => {
  const atmos = build(probe({ audio: [audio({ codec: "truehd", channels: 8, hasAtmos: true })] }));
  assert.equal(arg(atmos.args, "-c:a:0"), "copy");

  const plain = build(probe({ audio: [audio({ codec: "truehd", channels: 8, hasAtmos: false })] }));
  assert.equal(arg(plain.args, "-c:a:0"), "ac3", "lossless without Atmos is just large");
  assert.match(arg(plain.args, "-filter:a:0") ?? "", /^pan=5\.1\|/);
});

test("the builder reports the stream counts the verifier checks against", () => {
  const p = probe({
    audio: [audio({ index: 1 }), audio({ index: 2, language: "rus" })],
    subtitles: [sub({ index: 10 }), sub({ index: 11 })],
  });
  const built = build(p, DEFAULT_PRESET, { audio: [1, 2], subtitles: [10] });
  assert.equal(built.expectedAudioStreams, 2);
  assert.equal(built.expectedSubtitleStreams, 1);
});

test("a non-Atmos file still replaces, which is the bigger saving", () => {
  const { args, audioPolicy } = build(probe());
  assert.equal(audioPolicy, "replace");
  assert.equal(arg(args, "-c:a:0"), "ac3");
  const maps = args.reduce<string[]>((acc, a, i) => (a === "-map" ? [...acc, args[i + 1]!] : acc), []);
  assert.equal(maps.filter((m) => m === "0:1").length, 1, "the source track is mapped once under replace");
});
