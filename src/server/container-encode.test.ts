import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCommand } from "./ffmpeg-args.ts";
import { probeFile } from "./probe.ts";
import { Encode } from "./encoder.ts";
import { keepEverything } from "../shared/estimate.ts";
import { DEFAULT_PRESET } from "../shared/preset.ts";

const BIN_DIR = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
  .find((dir) => existsSync(join(dir, "ffmpeg")) && existsSync(join(dir, "ffprobe")));

// Generate a tiny fixture; this must run on the Intel host without a private
// media file or access to the production library/database.
test("real FFmpeg encodes and copies HEVC into .m4v without renaming or changing stereo", {
  skip: BIN_DIR ? false : "FFmpeg and ffprobe are not installed",
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "convertly-container-"));
  const ffmpeg = join(BIN_DIR!, "ffmpeg");
  const ffprobe = join(BIN_DIR!, "ffprobe");
  const original = join(dir, "source.m4v");
  try {
    execFileSync(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-y", original,
    ], { timeout: 15_000 });
    const before = readFileSync(original);
    let input = original;
    for (const [name, encoder] of [["encoded.m4v", "libx265"], ["copied.M4V", "copy"]]) {
      const probe = await probeFile(ffprobe, input);
      const outputPath = join(dir, name!);
      const built = buildCommand({ probe, selection: keepEverything(probe),
        preset: { ...DEFAULT_PRESET, x265Preset: "veryfast" }, outputPath });
      assert.equal(built.encoder, encoder);
      const result = await new Encode().run({ ffmpegPath: ffmpeg, args: built.args,
        durationSec: probe.durationSec, totalFrames: 24, signal: AbortSignal.timeout(15_000) });
      assert.equal(result.ok, true, result.stderr);
      const output = await probeFile(ffprobe, outputPath);
      assert.equal(output.error, null);
      assert.equal(output.video?.codec, "hevc");
      assert.equal(output.video?.bitDepth, 10);
      assert.equal(output.video?.width, 320);
      assert.equal(output.audio.length, 1);
      assert.equal(output.audio[0]?.codec, "aac");
      assert.equal(output.audio[0]?.channels, 2);
      assert.ok(Math.abs(output.durationSec! - probe.durationSec!) < 0.1);
      const tag = execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_tag_string", "-of", "csv=p=0", outputPath], { encoding: "utf8", timeout: 5_000 });
      assert.equal(tag.trim(), "hvc1");
      execFileSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-xerror",
        "-i", outputPath, "-map", "0:v:0", "-map", "0:a", "-f", "null", "-"], { timeout: 10_000 });
      input = outputPath;
    }
    assert.deepEqual(readFileSync(original), before, "source must remain byte-identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
