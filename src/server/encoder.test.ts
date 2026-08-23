import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { estimateEta, parseSpeed, ETA_WINDOW_MS, ETA_MIN_SPAN_MS } from "./encoder.ts";

test("parseSpeed reads ffmpeg's trailing x", () => {
  assert.equal(parseSpeed("1.02x"), 1.02);
  assert.equal(parseSpeed("0.88x"), 0.88);
  assert.equal(parseSpeed(undefined), 0);
  assert.equal(parseSpeed("N/A"), 0);
});

test("ETA comes from frames encoded per second of wall clock", () => {
  // 60s produced 1440 frames = 24fps. 1440 of 2880 left -> 60s.
  const samples = [{ at: 0, frame: 0 }, { at: 60_000, frame: 1440 }];
  assert.equal(estimateEta(samples, 2880, 1440), 60);
});

test("ETA reflects a slowdown rather than the opening burst", () => {
  const fast = [{ at: 0, frame: 0 }, { at: 60_000, frame: 1440 }];
  const throttled = [{ at: 0, frame: 0 }, { at: 60_000, frame: 300 }];
  assert.ok(
    estimateEta(throttled, 2880, 300)! > estimateEta(fast, 2880, 1440)!,
    "a throttled machine must report a longer ETA, which is the point of measuring",
  );
});

test("ETA is withheld until the window is wide enough to trust", () => {
  assert.equal(estimateEta([{ at: 0, frame: 0 }, { at: 5_000, frame: 20 }], 2880, 20), null);
  assert.equal(estimateEta([{ at: 0, frame: 0 }, { at: ETA_MIN_SPAN_MS, frame: 480 }], 2880, 480), 100);
});

test("ETA is withheld rather than guessed", () => {
  assert.equal(estimateEta([{ at: 0, frame: 0 }], 2880, 0), null, "one sample is not a rate");
  assert.equal(estimateEta([{ at: 0, frame: 0 }, { at: 60_000, frame: 1440 }], null, 1440), null, "no frame count, no ETA");
  assert.equal(estimateEta([{ at: 0, frame: 50 }, { at: 60_000, frame: 50 }], 2880, 50), null, "stalled means unknown");
});

test("ETA floors at zero on the last block", () => {
  assert.equal(estimateEta([{ at: 0, frame: 0 }, { at: 60_000, frame: 2880 }], 2880, 2880), 0);
});

test("the trailing window rides over a plateau but still catches throttling", () => {
  assert.ok(ETA_WINDOW_MS >= 120_000, "a short window let one plateau halve the rate");
  assert.ok(ETA_WINDOW_MS <= 300_000, "too long and a thermal slowdown takes minutes to surface");
});

test("progress is never measured from out_time", () => {
  // out_time is the muxer's furthest-written timestamp. A stream-copied audio
  // track is written far ahead of the encode: on a 2-minute file it read 64s
  // — 53% — after eight video frames. Frames are the only honest measure.
  const text = readFileSync(fileURLToPath(new URL("./encoder.ts", import.meta.url)), "utf8");
  // The published value, not the type declaration: object-literal entries end
  // with a comma, the interface field ends with a semicolon.
  const assigned = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("fraction:") && l.endsWith(","));
  assert.equal(assigned.length, 1, `expected exactly one published fraction, got ${assigned.length}`);
  assert.match(assigned[0]!, /frame/, `fraction must derive from frame count, got: ${assigned[0]}`);
  assert.doesNotMatch(assigned[0]!, /outTimeSec/);
});
