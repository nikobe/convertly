import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, bitsPerPixel, primaryAudio, AC3_BITRATE, HARDWARE_MIN_HEIGHT } from "./classify.ts";
import type { Probe, AudioTrack } from "../shared/types.ts";

function probe(over: Partial<Probe> = {}): Probe {
  return {
    path: "/m/film.mkv", size: 24_000_000_000, mtimeMs: 1, durationSec: 7200,
    container: "matroska", chapters: 12, probedAt: 0, error: null, subtitles: [],
    video: { index: 0, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 25_000_000, hdr: null },
    audio: [audio({})],
    ...over,
  };
}
function audio(over: Partial<AudioTrack>): AudioTrack {
  return { index: 1, codec: "dts", channels: 6, channelLayout: "5.1", language: "eng", title: null, bitrate: 1_500_000, hasAtmos: false, ...over };
}
const labels = (p: Probe) => assess(p).chips.map((c) => c.label);

test("h264 + DTS needs both video and audio work", () => {
  const a = assess(probe());
  assert.equal(a.videoWork, true);
  assert.equal(a.audioWork, true);
  assert.ok(labels(probe()).includes("H264"));
  assert.ok(labels(probe()).includes("DTS"));
});

test("hevc + eac3 needs nothing and is marked OK", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 4_000_000, hdr: null },
    audio: [audio({ codec: "eac3", bitrate: 768_000 })],
  });
  const a = assess(p);
  assert.equal(a.videoWork, false);
  assert.equal(a.audioWork, false);
  assert.equal(a.encoder, null);
  assert.ok(labels(p).includes("OK"));
});

test("encoder splits on resolution at the 4K boundary", () => {
  const hd = assess(probe());
  assert.equal(hd.encoder, "libx265");

  const uhd = assess(probe({
    video: { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 60_000_000, hdr: null },
  }));
  assert.equal(uhd.encoder, "hevc_videotoolbox");
  assert.ok(2160 >= HARDWARE_MIN_HEIGHT);
});

test("hardware encodes are estimated larger than software for the same ratio", () => {
  const base = { index: 0, codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", bitDepth: 8, fps: 24, bitrate: 40_000_000, hdr: null } as const;
  const uhd = assess(probe({ video: { ...base } }));
  const hd = assess(probe({ video: { ...base, width: 1920, height: 1080 } }));
  // Same source bitrate and ratio; only the 1.3x hardware penalty differs.
  assert.ok(uhd.estimatedBytes! > hd.estimatedBytes!);
});

test("an already-efficient but bloated HEVC file is flagged", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 40_000_000, hdr: null },
    audio: [audio({ codec: "eac3", bitrate: 768_000 })],
  });
  const a = assess(p);
  assert.equal(a.videoWork, true);
  assert.ok(labels(p).includes("BLOATED"));
});

test("Atmos blocks conversion rather than silently discarding objects", () => {
  const p = probe({ audio: [audio({ codec: "truehd", hasAtmos: true })] });
  const a = assess(p);
  assert.match(a.blockedReason ?? "", /Atmos/);
  assert.ok(labels(p).includes("ATMOS"));
});

test("Dolby Vision is held back", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 3840, height: 2160, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 60_000_000, hdr: "Dolby Vision" },
    audio: [audio({ codec: "eac3", bitrate: 768_000 })],
  });
  assert.match(assess(p).blockedReason ?? "", /Dolby Vision/);
});

test("estimate replaces the primary track at the AC3 ceiling and keeps the rest", () => {
  const commentary = audio({ index: 2, codec: "ac3", channels: 2, bitrate: 192_000 });
  const a = assess(probe({ audio: [audio({}), commentary] }));
  // video 25 Mbps * 0.5 (h264->hevc) + 640k primary + 192k commentary, over 7200s
  const expected = Math.round(((12_500_000 + AC3_BITRATE + 192_000) * 7200 / 8) * 1.01);
  assert.equal(a.estimatedBytes, expected);
});

test("a file with no video stream is left alone", () => {
  const a = assess(probe({ video: null }));
  assert.equal(a.videoWork, false);
  assert.equal(a.blockedReason, "No video stream.");
});

test("an unreadable file reports the ffprobe error rather than guessing", () => {
  const a = assess(probe({ error: "Invalid data found when processing input" }));
  assert.ok(a.chips.some((c) => c.label === "UNREADABLE"));
  assert.equal(a.estimatedBytes, null);
});

test("primaryAudio picks the widest track", () => {
  const stereo = audio({ index: 1, channels: 2 });
  const surround = audio({ index: 2, channels: 6 });
  assert.equal(primaryAudio([stereo, surround])?.index, 2);
  assert.equal(primaryAudio([]), null);
});

test("bitsPerPixel returns null when any input is missing", () => {
  assert.equal(bitsPerPixel(null, 1920, 1080, 24), null);
  assert.equal(bitsPerPixel(25_000_000, 1920, 1080, null), null);
  assert.ok((bitsPerPixel(25_000_000, 1920, 1080, 24) ?? 0) > 0.4);
});
