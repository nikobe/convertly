import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, bitsPerPixel, primaryAudio, AC3_BITRATE, HARDWARE_MIN_HEIGHT } from "./classify.ts";
import { planFor, estimateBytes, keepEverything } from "../shared/estimate.ts";
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
  return { index: 1, codec: "dts", channels: 6, channelLayout: "5.1", language: "eng", title: null, bitrate: 1_500_000, hasAtmos: false, isDefault: false, ...over };
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
  // video 25 Mbps * 0.5 (h264->hevc) + 640k primary + 192k commentary, over
  // 7200s, plus 0.5% container overhead. No subtitles on this fixture.
  const expected = Math.round(((12_500_000 + AC3_BITRATE + 192_000) * 7200 / 8) * 1.005);
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

test("primaryAudio picks the widest track when languages match", () => {
  const stereo = audio({ index: 1, channels: 2 });
  const surround = audio({ index: 2, channels: 6 });
  assert.equal(primaryAudio([stereo, surround])?.index, 2);
  assert.equal(primaryAudio([]), null);
});

test("primaryAudio prefers your language over a wider foreign track", () => {
  // The shape of a real release: eight foreign-language dubs, one English stereo.
  const dubs = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
    audio({ index: i, codec: "ac3", channels: 6, language: "rus", bitrate: 448_000, isDefault: i === 1 }),
  );
  const english = audio({ index: 9, codec: "ac3", channels: 2, language: "eng", bitrate: 320_000 });
  assert.equal(primaryAudio([...dubs, english])?.index, 9);
});

test("an explicit English tag beats a wider untagged track", () => {
  // On a foreign release the untagged 5.1 is usually a dub, not the original.
  const untagged = audio({ index: 1, codec: "ac3", channels: 6, language: null, bitrate: 384_000 });
  const english = audio({ index: 2, codec: "ac3", channels: 2, language: "eng", bitrate: 320_000 });
  assert.equal(primaryAudio([untagged, english])?.index, 2);
});

test("an untagged track still beats a tagged foreign one", () => {
  const dub = audio({ index: 1, codec: "ac3", channels: 6, language: "rus" });
  const untagged = audio({ index: 2, codec: "ac3", channels: 6, language: null });
  assert.equal(primaryAudio([dub, untagged])?.index, 2);
});

test("primaryAudio falls back to channels when nothing is tagged with a language", () => {
  const a = audio({ index: 1, channels: 2, language: null });
  const b = audio({ index: 2, channels: 6, language: null });
  assert.equal(primaryAudio([a, b])?.index, 2);
});

test("a pile of dub tracks is surfaced as a chip", () => {
  const tracks = [1, 2, 3, 4, 5].map((i) =>
    audio({ index: i, codec: "ac3", channels: 6, language: i === 5 ? "eng" : "rus", bitrate: 448_000 }),
  );
  const a = assess(probe({ audio: tracks }));
  const chip = a.chips.find((c) => c.label === "5 AUDIO");
  assert.ok(chip, "expected a track-count chip");
  assert.match(chip!.title, /eng/);
});

test("bitsPerPixel returns null when any input is missing", () => {
  assert.equal(bitsPerPixel(null, 1920, 1080, 24), null);
  assert.equal(bitsPerPixel(25_000_000, 1920, 1080, null), null);
  assert.ok((bitsPerPixel(25_000_000, 1920, 1080, 24) ?? 0) > 0.4);
});

test("dropping dub tracks shrinks the estimate", () => {
  const tracks = [1, 2, 3, 4].map((i) =>
    audio({ index: i, codec: "ac3", channels: 6, language: i === 1 ? "eng" : "rus", bitrate: 448_000 }),
  );
  const p = probe({ audio: tracks });
  const plan = planFor(p);

  const all = estimateBytes(p, plan, keepEverything(p))!;
  const englishOnly = estimateBytes(p, plan, { audio: [1], subtitles: [] })!;

  assert.ok(englishOnly < all, "keeping one track must estimate smaller than keeping four");
  // Three dropped tracks at 448 kbps over 7200s, give or take the overhead.
  const saved = all - englishOnly;
  assert.ok(Math.abs(saved - (3 * 448_000 * 7200) / 8) / saved < 0.02);
});

test("dropping image subtitles is worth more than dropping text ones", () => {
  const subs = [
    { index: 10, codec: "hdmv_pgs_subtitle", language: "eng", title: null, forced: false },
    { index: 11, codec: "subrip", language: "eng", title: null, forced: false },
  ];
  const p = probe({ subtitles: subs });
  const plan = planFor(p);
  const noPgs = estimateBytes(p, plan, { audio: [1], subtitles: [11] })!;
  const noSrt = estimateBytes(p, plan, { audio: [1], subtitles: [10] })!;
  assert.ok(noPgs < noSrt, "dropping the PGS track should save more than dropping the SRT");
});

test("keeping everything on a file needing no work returns the original size", () => {
  const p = probe({
    video: { index: 0, codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", bitDepth: 10, fps: 24, bitrate: 4_000_000, hdr: null },
    audio: [audio({ codec: "eac3", bitrate: 768_000 })],
  });
  assert.equal(estimateBytes(p, planFor(p), keepEverything(p)), p.size);
});
