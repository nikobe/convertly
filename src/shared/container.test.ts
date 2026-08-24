import { test } from "node:test";
import assert from "node:assert/strict";
import { planContainer, withExtension } from "./container.ts";

test("mkv stays mkv, so the filename is untouched", () => {
  const p = planContainer("/m/Film (1999) Bluray-1080p.mkv");
  assert.equal(p.extension, ".mkv");
  assert.equal(p.changed, false);
  assert.equal(p.needsHvc1, false);
});

test("mp4 keeps its container and gets the hvc1 tag", () => {
  // HEVC in an MP4 family container plays on Apple devices only when tagged.
  for (const ext of [".mp4", ".m4v", ".mov"]) {
    const p = planContainer(`/m/Show S01E01${ext}`);
    assert.equal(p.extension, ext, ext);
    assert.equal(p.changed, false, ext);
    assert.equal(p.needsHvc1, true, ext);
  }
});

test("avi has to become mkv, because HEVC cannot go in it", () => {
  // The alternative was a Matroska file named .avi, which is a lie on disk.
  const p = planContainer("/m/ulysses.31.01-dvdrip.xvid.avi");
  assert.equal(p.extension, ".mkv");
  assert.equal(p.changed, true);
  assert.match(p.reason ?? "", /cannot carry HEVC/);
  assert.match(p.reason ?? "", /Sonarr and Radarr will notice/);
});

test("other legacy containers behave the same way", () => {
  for (const ext of [".wmv", ".mpg", ".mpeg", ".divx", ".vob"]) {
    assert.equal(planContainer(`/m/old${ext}`).changed, true, ext);
  }
});

test("case does not matter", () => {
  assert.equal(planContainer("/m/Film.MKV").changed, false);
  assert.equal(planContainer("/m/Film.AVI").changed, true);
});

test("withExtension replaces only the extension", () => {
  assert.equal(withExtension("/m/a.b.c/Show S01E01.avi", ".mkv"), "/m/a.b.c/Show S01E01.mkv");
  assert.equal(withExtension("/m/no-extension", ".mkv"), "/m/no-extension.mkv");
  assert.equal(
    withExtension("/m/ulysses.31.01.vengeance-dvdrip.xvid.[merchant].avi", ".mkv"),
    "/m/ulysses.31.01.vengeance-dvdrip.xvid.[merchant].mkv",
    "dots inside the name must survive",
  );
});
