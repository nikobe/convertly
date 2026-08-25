import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync,
  existsSync, utimesSync, chmodSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  replaceInPlace, restore, sweepQuarantine, quarantinedAt, ReplaceError, QUARANTINE_DIRNAME,
} from "./replace.ts";
import { PathNotAllowedError } from "./paths.ts";
import type { Root } from "../shared/types.ts";

const NAME = "Sample Feature (1999) Bluray-1080p x264 DTS-HD MA 5.1.mkv";
const OLD_MTIME = new Date("2019-03-04T10:11:12Z");

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "convertly-replace-")));
  const movies = join(base, "Movies");
  const tmp = join(movies, ".convertly-tmp");
  mkdirSync(tmp, { recursive: true });

  const original = join(movies, NAME);
  writeFileSync(original, "ORIGINAL-CONTENT-that-is-larger");
  utimesSync(original, OLD_MTIME, OLD_MTIME);
  chmodSync(original, 0o644);

  const encoded = join(tmp, "out.mkv");
  writeFileSync(encoded, "NEW");

  const roots: Root[] = [{ id: "m", label: "Movies", path: movies }];
  return { base, movies, tmp, original, encoded, roots };
}

test("the live filename is byte-identical after the swap", () => {
  const { movies, original, encoded, roots } = fixture();
  const record = replaceInPlace(original, encoded, roots);

  assert.equal(record.livePath, original);
  assert.equal(readFileSync(original, "utf8"), "NEW", "the new file must be at the original path");
  const names = readdirSync(movies).filter((n) => n !== QUARANTINE_DIRNAME && n !== ".convertly-tmp");
  assert.deepEqual(names, [NAME], "no renamed leftovers beside it");
});

test("the original mtime is restored, so nothing downstream sees a new file", () => {
  const { original, encoded, roots } = fixture();
  replaceInPlace(original, encoded, roots);
  assert.equal(
    Math.round(statSync(original).mtimeMs),
    Math.round(OLD_MTIME.getTime()),
    "a changed mtime is what makes a scanner re-read the file",
  );
});

test("permissions carry over", () => {
  const { original, encoded, roots } = fixture();
  chmodSync(original, 0o640);
  replaceInPlace(original, encoded, roots);
  assert.equal(statSync(original).mode & 0o777, 0o640);
});

test("the original is kept in quarantine, not deleted", () => {
  const { original, encoded, roots } = fixture();
  const record = replaceInPlace(original, encoded, roots);
  assert.ok(existsSync(record.quarantinePath));
  assert.equal(readFileSync(record.quarantinePath, "utf8"), "ORIGINAL-CONTENT-that-is-larger");
  assert.match(record.quarantinePath, new RegExp(`${QUARANTINE_DIRNAME}/.*__${NAME.replace(/[()]/g, "\\$&")}$`));
});

test("restore puts the original back and parks the encode", () => {
  const { original, encoded, roots } = fixture();
  const record = replaceInPlace(original, encoded, roots);
  restore(record, roots);

  assert.equal(readFileSync(original, "utf8"), "ORIGINAL-CONTENT-that-is-larger");
  assert.equal(Math.round(statSync(original).mtimeMs), Math.round(OLD_MTIME.getTime()));
  assert.ok(existsSync(`${record.quarantinePath}.replaced`), "the encode is kept, so undo is itself undoable");
});

test("refuses a cross-volume swap rather than silently copying", () => {
  const { original, roots } = fixture();
  // A temp file on a different filesystem, faked by pointing outside the root.
  const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), "convertly-other-"))), "out.mkv");
  writeFileSync(elsewhere, "NEW");
  assert.throws(() => replaceInPlace(original, elsewhere, roots), PathNotAllowedError);
});

test("refuses to swap in an empty file", () => {
  const { original, tmp, roots } = fixture();
  const empty = join(tmp, "empty.mkv");
  writeFileSync(empty, "");
  assert.throws(() => replaceInPlace(original, empty, roots), ReplaceError);
});

test("refuses when the original has vanished", () => {
  const { movies, encoded, roots } = fixture();
  assert.throws(() => replaceInPlace(join(movies, "gone.mkv"), encoded, roots), ReplaceError);
});

test("refuses paths outside the configured roots", () => {
  const { encoded, roots } = fixture();
  assert.throws(() => replaceInPlace("/etc/hosts", encoded, roots), PathNotAllowedError);
});

test("sweep keeps everything inside the retention window", () => {
  const { original, encoded, roots } = fixture();
  replaceInPlace(original, encoded, roots);
  const result = sweepQuarantine(roots, 14);
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept, 1);
});

test("sweep removes originals past the window and reports what it freed", () => {
  const { original, encoded, roots } = fixture();
  const record = replaceInPlace(original, encoded, roots);
  const size = statSync(record.quarantinePath).size;

  const fifteenDaysOn = Date.now() + 15 * 24 * 60 * 60 * 1000;
  const result = sweepQuarantine(roots, 14, fifteenDaysOn);

  assert.deepEqual(result.removed, [record.quarantinePath]);
  assert.equal(result.freedBytes, size);
  assert.equal(existsSync(record.quarantinePath), false);
});

test("sweep never looks outside a quarantine directory", () => {
  const { movies, original, encoded, roots } = fixture();
  const bystander = join(movies, "Some Other Film.mkv");
  writeFileSync(bystander, "DO NOT TOUCH");
  replaceInPlace(original, encoded, roots);

  sweepQuarantine(roots, 0, Date.now() + 1e9);
  assert.ok(existsSync(bystander), "a file outside quarantine must never be swept");
  assert.equal(readFileSync(bystander, "utf8"), "DO NOT TOUCH");
});

test("a container that cannot hold HEVC is renamed, not mislabelled", () => {
  // An AVI source produced a Matroska file that then got renamed back to
  // .avi — a lie on disk. HEVC cannot go in AVI, so the name has to change.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "convertly-avi-")));
  const movies = join(base, "Shows");
  const tmp = join(movies, ".convertly-tmp");
  mkdirSync(tmp, { recursive: true });
  const original = join(movies, "ulysses.31.01-dvdrip.xvid.[merchant].avi");
  writeFileSync(original, "OLD-AVI-CONTENT");
  utimesSync(original, OLD_MTIME, OLD_MTIME);
  const encoded = join(tmp, "ulysses.31.01-dvdrip.xvid.[merchant].123.mkv");
  writeFileSync(encoded, "NEW");
  const roots: Root[] = [{ id: "s", label: "Shows", path: movies }];

  const destination = join(movies, "ulysses.31.01-dvdrip.xvid.[merchant].mkv");
  const record = replaceInPlace(original, encoded, roots, destination);

  assert.equal(record.livePath, destination);
  assert.equal(readFileSync(destination, "utf8"), "NEW");
  assert.equal(existsSync(original), false, "the .avi name must not survive alongside it");
  assert.equal(Math.round(statSync(destination).mtimeMs), Math.round(OLD_MTIME.getTime()));
  assert.equal(readFileSync(record.quarantinePath, "utf8"), "OLD-AVI-CONTENT");
});

test("retention is judged by the stamp we wrote, not by file metadata", () => {
  // On the external volumes this runs against, renaming into quarantine
  // leaves ctime untouched — so a 2018 release read as seven years old and
  // was swept minutes after being quarantined.
  const now = Date.parse("2026-08-25T23:00:00.000Z");
  assert.equal(quarantinedAt("2026-08-25T18-01-54-566Z__Some Film.mkv"), Date.parse("2026-08-25T18:01:54.566Z"));
  assert.ok(quarantinedAt("2026-08-25T18-01-54-566Z__Some Film.mkv")! > now - 14 * 864e5, "today is inside the window");
  assert.ok(quarantinedAt("2026-07-01T10-00-00-000Z__Old.mkv")! < now - 14 * 864e5, "seven weeks ago is outside it");
});

test("anything without our stamp is never swept", () => {
  // A file we did not put there must not be deleted on a guess.
  for (const name of ["Some Film.mkv", "backup.mkv", "2026-08-25__no-time.mkv", ""]) {
    assert.equal(quarantinedAt(name), null, name);
  }
});

test("a freshly quarantined original survives a sweep even with an ancient ctime", () => {
  const { original, encoded, roots } = fixture();
  const record = replaceInPlace(original, encoded, roots);
  // Simulate the volume behaviour: metadata still says years ago.
  const ancient = new Date("2018-10-27T02:03:00Z");
  utimesSync(record.quarantinePath, ancient, ancient);

  const result = sweepQuarantine(roots, 14);
  assert.deepEqual(result.removed, [], "it was quarantined seconds ago");
  assert.equal(existsSync(record.quarantinePath), true);
});
