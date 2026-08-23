import { test } from "node:test";
import assert from "node:assert/strict";
import { assumedAudioBitrate } from "./probe.ts";
import type { AudioTrack } from "../shared/types.ts";

const track = (over: Partial<AudioTrack>): AudioTrack => ({
  index: 1, codec: "truehd", channels: 6, channelLayout: "5.1", language: "eng",
  title: null, bitrate: null, hasAtmos: false, isDefault: true, ...over,
});

test("lossless tracks are assumed to cost real bandwidth", () => {
  // Assuming zero attributed their bitrate to video, which made a TrueHD film
  // estimate larger after conversion than before.
  assert.ok(assumedAudioBitrate(track({ codec: "truehd" })) > 3_000_000);
  assert.ok(assumedAudioBitrate(track({ codec: "pcm_s24le" })) > 6_000_000);
  assert.ok(assumedAudioBitrate(track({ codec: "flac" })) > 3_000_000);
});

test("wider tracks are assumed to cost more", () => {
  assert.ok(assumedAudioBitrate(track({ channels: 8 })) > assumedAudioBitrate(track({ channels: 6 })));
});

test("a compressed track falls back to something modest", () => {
  assert.ok(assumedAudioBitrate(track({ codec: "eac3", channels: 6 })) <= 768_000);
});
