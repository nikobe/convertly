import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, statSync, existsSync, readdirSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runJob, freshProbe, TEMP_DIRNAME } from "./pipeline.ts";
import { QUARANTINE_DIRNAME } from "./replace.ts";
import { keepEverything } from "../shared/estimate.ts";
import { DEFAULT_PRESET, type Preset } from "../shared/preset.ts";
import type { Root } from "../shared/types.ts";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const SOURCE = fileURLToPath(new URL("../../fixtures/Movies/Sample Feature (1999) Bluray-1080p x264 DTS-HD MA 5.1.mkv", import.meta.url));
const NAME = "Sample Feature (1999) Bluray-1080p x264 DTS-HD MA 5.1.mkv";
const OLD_MTIME = new Date("2019-03-04T10:11:12Z");
const available = existsSync(FFMPEG) && existsSync(SOURCE);
const FAST: Preset = { ...DEFAULT_PRESET, x265Preset: "ultrafast" as Preset["x265Preset"] };

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "convertly-pipe-")));
  const movies = join(dir, "Movies");
  mkdirSync(movies);
  const path = join(movies, NAME);
  copyFileSync(SOURCE, path);
  utimesSync(path, OLD_MTIME, OLD_MTIME);
  const roots: Root[] = [{ id: "m", label: "Movies", path: movies }];
  return { movies, path, roots, before: statSync(path) };
}

const base = (roots: Root[]) => ({
  roots, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, ffmpegVersion: "test",
});

test("a successful job replaces in place and keeps the original", { skip: !available }, async () => {
  const { movies, path, roots, before } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  const result = await runJob({ probe, selection: keepEverything(probe), preset: FAST, ...base(roots) });

  assert.equal(result.outcome, "replaced", result.message);
  assert.ok(readdirSync(movies).includes(NAME), "the filename must be byte-identical");
  assert.equal(Math.round(statSync(path).mtimeMs), Math.round(before.mtimeMs), "mtime must survive");
  assert.ok(statSync(path).size < before.size, "the point is a smaller file");
  assert.ok(result.record && existsSync(result.record.quarantinePath), "original must be recoverable");
  assert.ok(result.checks.every((c) => c.status === "pass"), JSON.stringify(result.checks));
  assert.equal(existsSync(join(movies, TEMP_DIRNAME, "x")), false);
});

test("a failing ffmpeg leaves the library exactly as it was", { skip: !available }, async () => {
  const { movies, path, roots, before } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  // /usr/bin/false exits non-zero without writing anything.
  const result = await runJob({ probe, selection: keepEverything(probe), preset: FAST, ...base(roots), ffmpegPath: "/usr/bin/false" });

  assert.equal(result.outcome, "failed");
  assert.match(result.message, /original untouched/i);
  assert.equal(statSync(path).size, before.size, "the original must be byte-for-byte intact");
  assert.equal(Math.round(statSync(path).mtimeMs), Math.round(before.mtimeMs));
  assert.equal(existsSync(join(movies, QUARANTINE_DIRNAME)), false, "nothing should have been quarantined");
  const temp = join(movies, TEMP_DIRNAME);
  assert.ok(!existsSync(temp) || readdirSync(temp).length === 0, "temp files must be cleaned up");
});

test("a dry run verifies but deliberately does not swap", { skip: !available }, async () => {
  const { movies, path, roots, before } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  const result = await runJob({ probe, selection: keepEverything(probe), preset: FAST, ...base(roots), dryRun: true });

  assert.equal(result.outcome, "review");
  assert.equal(statSync(path).size, before.size, "the original must still be the original");
  assert.equal(existsSync(join(movies, QUARANTINE_DIRNAME)), false);
  assert.ok(result.pendingPath && existsSync(result.pendingPath), "the encode is kept so accepting costs nothing");
  assert.ok(result.checks.filter((c) => c.status === "pass").length >= 6);
});

test("cancelling stops before anything is replaced", { skip: !available }, async () => {
  const { movies, path, roots, before } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  const controller = new AbortController();
  queueMicrotask(() => controller.abort());
  const result = await runJob({
    probe, selection: keepEverything(probe), preset: DEFAULT_PRESET, ...base(roots), signal: controller.signal,
  });

  assert.equal(result.outcome, "cancelled");
  assert.equal(statSync(path).size, before.size);
  assert.equal(existsSync(join(movies, QUARANTINE_DIRNAME)), false);
});

test("the builder's refusals surface as a failed job, not a crash", { skip: !available }, async () => {
  const { path, roots, before } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  const result = await runJob({ probe, selection: { audio: [], subtitles: [] }, preset: FAST, ...base(roots) });

  assert.equal(result.outcome, "failed");
  assert.match(result.message, /at least one audio track/i);
  assert.equal(statSync(path).size, before.size);
});

test("the ffmpeg version is recorded against every job", { skip: !available }, async () => {
  const { path, roots } = fixture();
  const probe = await freshProbe(FFPROBE, path);
  const result = await runJob({ probe, selection: keepEverything(probe), preset: FAST, ...base(roots), dryRun: true });
  assert.equal(result.ffmpegVersion, "test");
  assert.ok(result.command.length > 5, "the exact command must be kept for when something looks wrong");
});
