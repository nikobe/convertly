import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFileName } from "./filename.ts";

const tailOf = (name: string, n = 16) => splitFileName(name, n).tail;

test("two files differing only at the end stay distinguishable", () => {
  const a = "Sample Cartoon - Ep. 01 - The First One (480p - DVDRip) OG.mp4";
  const b = "Sample Cartoon - Ep. 01 - The First One (480p - DVDRip).mp4";
  assert.notEqual(tailOf(a), tailOf(b), "identical tails would make the truncation useless");
  assert.match(tailOf(a), /OG\.mp4$/);
  assert.match(tailOf(b), /\)\.mp4$/);
});

test("the extension always survives", () => {
  for (const name of [
    "Sample Series - S01E01 - An Episode With A Fairly Long Name WEBDL-1080p.mkv",
    "Sample Feature (1999) Bluray-1080p x264 DTS-HD MA 5.1.mkv",
    "Sample Series - S01E02 - Another Episode (2) WEBDL-480p.mkv",
  ]) {
    assert.ok(tailOf(name).endsWith(name.slice(name.lastIndexOf("."))), name);
  }
});

test("a copy suffix is visible — the case that prompted this", () => {
  const original = "Some Long Film Name Here (2019) Bluray-1080p.mkv";
  const clone = "Some Long Film Name Here (2019) Bluray-1080p copy.mkv";
  assert.notEqual(tailOf(original), tailOf(clone));
  assert.match(tailOf(clone), /copy\.mkv$/);
});

test("the tail never starts with whitespace", () => {
  assert.doesNotMatch(tailOf("Sample Cartoon - Ep. 01 - The First One (480p - DVDRip) OG.mp4"), /^\s/);
});

test("short names are left whole", () => {
  const { head, tail } = splitFileName("short.mkv");
  assert.equal(head, "short.mkv");
  assert.equal(tail, "");
});

test("head and tail always reconstruct the name apart from the trimmed gap", () => {
  const name = "Sample Feature 4K (2001) Bluray-2160p x264 TrueHD 5.1.mkv";
  const { head, tail } = splitFileName(name);
  assert.equal(`${head}${name.slice(head.length).slice(0, name.slice(head.length).length - tail.length)}${tail}`, name);
});
