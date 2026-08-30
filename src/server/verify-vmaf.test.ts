import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeFile } from "./probe.ts";
import { verify } from "./verify.ts";
import { keepEverything } from "../shared/estimate.ts";

const BIN_DIR = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
  .find((dir) => existsSync(join(dir, "ffmpeg")) && existsSync(join(dir, "ffprobe")));

test("VMAF tolerates muxer timestamp rounding but still rejects different pictures", {
  skip: BIN_DIR ? false : "FFmpeg and ffprobe are not installed",
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "convertly-vmaf-"));
  const ffmpegPath = join(BIN_DIR!, "ffmpeg");
  const ffprobePath = join(BIN_DIR!, "ffprobe");
  const sourcePath = join(dir, "source.mp4");
  const copiedPath = join(dir, "different-time-base.mp4");
  const shiftedPath = join(dir, "wrong-pictures.mp4");
  const ffmpeg = (args: string[]) => execFileSync(ffmpegPath,
    ["-hide_banner", "-nostdin", "-v", "error", ...args], { timeout: 10_000 });
  try {
    // Same compressed pictures, but container timestamp precision differs.
    // Default framesync can match the preceding picture due to rounding.
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24000/1001",
      "-t", "2", "-c:v", "libx264", "-crf", "0", "-video_track_timescale", "90000", sourcePath]);
    ffmpeg(["-i", sourcePath, "-c", "copy", "-video_track_timescale", "24000", copiedPath]);
    const source = await probeFile(ffprobePath, sourcePath);
    const options = { ffmpegPath, ffprobePath, source, selection: keepEverything(source),
      vmafSampleSeconds: 3, signal: AbortSignal.timeout(20_000) };
    const identical = await verify({ ...options, outputPath: copiedPath });
    assert.equal(identical.checks.find((check) => check.id === "vmaf")?.status, "pass", JSON.stringify(identical.checks));
    assert.ok(identical.vmaf !== null && identical.vmaf > 99, `identical pictures scored ${identical.vmaf}`);

    // Deliberately move the content by five frames. Nearest timestamps must
    // not search for matching content or hide real temporal differences.
    ffmpeg(["-i", sourcePath, "-vf", "trim=start_frame=5,setpts=PTS-STARTPTS",
      "-c:v", "libx264", "-crf", "0", "-video_track_timescale", "24000", shiftedPath]);
    const shifted = await verify({ ...options, outputPath: shiftedPath });
    assert.ok(shifted.vmaf !== null && shifted.vmaf < 93, `wrong pictures scored ${shifted.vmaf}`);
    assert.equal(shifted.checks.find((check) => check.id === "vmaf")?.status, "review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
