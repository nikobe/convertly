import { test } from "node:test";
import assert from "node:assert/strict";
import { planFor, estimateBytes, keepEverything, crfFactor, ac3BitrateFor, outputChannels } from "./estimate.ts";
import type { Probe, AudioTrack } from "./types.ts";

function audio(over: Partial<AudioTrack> = {}): AudioTrack {
  return { index: 1, codec: "ac3", channels: 6, channelLayout: "5.1", language: "eng", title: null, bitrate: 640_000, hasAtmos: false, isDefault: true, ...over };
}
function probe(over: Partial<Probe> = {}): Probe {
  return {
    path: "/m/f.mkv", size: 24e9, mtimeMs: 1, durationSec: 7200, container: "matroska", chapters: 0,
    probedAt: 0, error: null, subtitles: [], audio: [audio()],
    video: { index: 0, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 25e6, hdr: null, colorTransfer: null },
    ...over,
  };
}

test("six CRF steps roughly double or halve the bitrate", () => {
  assert.equal(crfFactor(20), 1);
  assert.ok(Math.abs(crfFactor(14) - 2) < 0.01);
  assert.ok(Math.abs(crfFactor(26) - 0.5) < 0.01);
});

test("a lower CRF projects a bigger file, and the slider moves the number", () => {
  const p = probe();
  const plan = planFor(p);
  const sel = keepEverything(p);
  const high = estimateBytes(p, plan, sel, { crf: 16 })!;
  const base = estimateBytes(p, plan, sel, { crf: 20 })!;
  const low = estimateBytes(p, plan, sel, { crf: 24 })!;
  assert.ok(high > base && base > low, `${high} > ${base} > ${low}`);
});

test("a resolution cap shrinks the projection", () => {
  const p = probe();
  const plan = planFor(p);
  const sel = keepEverything(p);
  const full = estimateBytes(p, plan, sel, {})!;
  const capped = estimateBytes(p, plan, sel, { maxHeight: 720 })!;
  assert.ok(capped < full);
});

test("a cap above the source height changes nothing", () => {
  const p = probe();
  const plan = planFor(p);
  const sel = keepEverything(p);
  assert.equal(estimateBytes(p, plan, sel, { maxHeight: 2160 }), estimateBytes(p, plan, sel, {}));
});

test("AC3 bitrate scales with channels and never exceeds the preset ceiling", () => {
  assert.equal(ac3BitrateFor(6), 640_000);
  assert.equal(ac3BitrateFor(2), 224_000);
  assert.equal(ac3BitrateFor(1), 128_000);
  assert.equal(ac3BitrateFor(6, 448_000), 448_000, "a lower preset ceiling must win");
});

test("channels are capped, never raised", () => {
  assert.equal(outputChannels(8), 6);
  assert.equal(outputChannels(2), 2);
  assert.equal(outputChannels(1), 1);
});
