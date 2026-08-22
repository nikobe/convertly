import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin, resolveWithinRoots, PathNotAllowedError } from "./paths.ts";
import type { Root } from "../shared/types.ts";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "convertly-paths-")));
  const media = join(base, "Media");
  const movies = join(media, "Movies");
  const archive = join(media, "MoviesArchive");
  const secret = join(base, "Secret");
  mkdirSync(movies, { recursive: true });
  mkdirSync(archive, { recursive: true });
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(movies, "film.mkv"), "x");
  writeFileSync(join(secret, "keys.txt"), "x");
  const roots: Root[] = [{ id: "m", label: "Movies", path: movies }];
  return { base, movies, archive, secret, roots };
}

test("accepts the root itself and files beneath it", () => {
  const { movies, roots } = fixture();
  assert.equal(resolveWithinRoots(movies, roots).path, movies);
  assert.equal(resolveWithinRoots(join(movies, "film.mkv"), roots).path, join(movies, "film.mkv"));
});

test("rejects a sibling directory sharing the root's name prefix", () => {
  const { archive, roots } = fixture();
  assert.throws(() => resolveWithinRoots(archive, roots), PathNotAllowedError);
});

test("rejects traversal out of the root", () => {
  const { movies, roots } = fixture();
  assert.throws(() => resolveWithinRoots(join(movies, "..", "Secret", "keys.txt"), roots), PathNotAllowedError);
});

test("rejects a symlink inside the root that points outside it", () => {
  const { movies, secret, roots } = fixture();
  const link = join(movies, "escape");
  symlinkSync(secret, link);
  assert.throws(() => resolveWithinRoots(join(link, "keys.txt"), roots), PathNotAllowedError);
});

test("rejects a path that does not exist outside the root", () => {
  const { base, roots } = fixture();
  assert.throws(() => resolveWithinRoots(join(base, "nope", "x.mkv"), roots), PathNotAllowedError);
});

test("allows a not-yet-existing path inside the root", () => {
  const { movies, roots } = fixture();
  const target = join(movies, "new", "out.mkv");
  assert.equal(resolveWithinRoots(target, roots).path, target);
});

test("rejects empty, non-string and NUL-bearing paths", () => {
  const { roots } = fixture();
  assert.throws(() => resolveWithinRoots("", roots), PathNotAllowedError);
  assert.throws(() => resolveWithinRoots("/tmp/a\0b", roots), PathNotAllowedError);
});

test("isWithin respects separator boundaries", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a"), false);
});
