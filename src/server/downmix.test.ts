import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DOWNMIX_7_1_TO_5_1 } from "./ffmpeg-args.ts";

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);

/**
 * The string tests assert the filter's shape. They cannot tell whether ffmpeg
 * will accept it — and it did not: naming SL/SR as outputs of a "5.1" layout
 * failed every real 7.1 file with "Invalid argument", after the encode had
 * already started.
 */
test("ffmpeg itself accepts the downmix on a real 7.1 source", { skip: !FFMPEG }, () => {
  execFileSync(FFMPEG!, [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-af", `pan=7.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0|SL=c0|SR=c0,${DOWNMIX_7_1_TO_5_1}`,
    "-c:a", "ac3", "-b:a", "640000",
    "-f", "null", "-",
  ]);
});

test("the layout it produces really is 5.1", { skip: !FFMPEG }, () => {
  // ffmpeg reports stream layout on stderr, not stdout.
  const result = spawnSync(FFMPEG!, [
    "-hide_banner",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-af", `pan=7.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0|SL=c0|SR=c0,${DOWNMIX_7_1_TO_5_1}`,
    "-c:a", "ac3", "-f", "null", "-",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Audio: ac3.*5\.1/, result.stderr.slice(-400));
});

test("the centre channel is passed through at full level", () => {
  // Dialogue lives here. ffmpeg's default fold drops it against the surrounds,
  // which is the whole reason for spelling the downmix out.
  assert.match(DOWNMIX_7_1_TO_5_1, /\|FC=FC(\||$)/);
});
