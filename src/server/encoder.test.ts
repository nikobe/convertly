import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateEta, parseSpeed } from "./encoder.ts";

test("parseSpeed reads ffmpeg's trailing x", () => {
  assert.equal(parseSpeed("1.02x"), 1.02);
  assert.equal(parseSpeed("0.88x"), 0.88);
  assert.equal(parseSpeed(undefined), 0);
  assert.equal(parseSpeed("N/A"), 0);
});

test("ETA comes from measured throughput", () => {
  // 60s of wall time produced 30s of media: 0.5x. 570s of media left -> 1140s.
  const samples = [{ at: 0, outTime: 0 }, { at: 60_000, outTime: 30 }];
  assert.equal(estimateEta(samples, 600, 30), 1140);
});

test("ETA reflects a slowdown rather than the opening burst", () => {
  const fast = [{ at: 0, outTime: 0 }, { at: 10_000, outTime: 30 }];
  const throttled = [{ at: 0, outTime: 0 }, { at: 10_000, outTime: 6 }];
  assert.ok(
    estimateEta(throttled, 600, 6)! > estimateEta(fast, 600, 30)!,
    "a throttled machine must report a longer ETA, which is the point of measuring",
  );
});

test("ETA is withheld rather than guessed", () => {
  assert.equal(estimateEta([{ at: 0, outTime: 0 }], 600, 0), null, "one sample is not a rate");
  assert.equal(estimateEta([{ at: 0, outTime: 0 }, { at: 60_000, outTime: 30 }], null, 30), null, "no duration, no ETA");
  assert.equal(estimateEta([{ at: 0, outTime: 5 }, { at: 60_000, outTime: 5 }], 600, 5), null, "stalled means unknown");
});

test("ETA floors at zero on the last block", () => {
  assert.equal(estimateEta([{ at: 0, outTime: 0 }, { at: 60_000, outTime: 600 }], 600, 605), 0);
});
