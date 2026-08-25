import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryable } from "./queue.ts";

test("circumstantial failures are worth retrying", () => {
  // All seen for real: the server stopped mid-encode, two servers fought over
  // the database, and a downmix bug that has since been fixed.
  for (const message of [
    "Verification failed, original untouched. Output readable: ENOENT: no such file or directory",
    "database is locked — the original was not touched.",
    "ffmpeg failed, original untouched: Error opening output files: Invalid argument",
    "Cancelled before anything was replaced.",
    "Requeued after the server restarted mid-encode.",
  ]) {
    assert.equal(isRetryable(message), true, message.slice(0, 40));
  }
});

test("failures that are properties of the file are not", () => {
  // Retrying these spends an encode to print the same sentence.
  for (const message of [
    "At least one audio track must be kept.",
    "No video stream.",
    "ffprobe could not read this file: Invalid data found when processing input",
    "Refusing to encode an unreadable file: moov atom not found",
    "The encoded file is on a different volume from the original",
  ]) {
    assert.equal(isRetryable(message), false, message.slice(0, 40));
  }
});
