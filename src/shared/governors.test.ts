import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClock, isWithinWindow, minutesUntilWindow, advanceRhythm,
  hasDiskRoom, FRESH_RHYTHM, DEFAULT_GOVERNORS, isThrottling,
} from "./governors.ts";

const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m);

test("clock strings parse, and rubbish does not", () => {
  assert.equal(parseClock("01:00"), 60);
  assert.equal(parseClock("08:30"), 510);
  assert.equal(parseClock("00:00"), 0);
  assert.equal(parseClock("23:59"), 1439);
  for (const bad of ["24:00", "12:60", "noon", "", "1200"]) assert.equal(parseClock(bad), null, bad);
});

test("a daytime window includes only its own hours", () => {
  assert.equal(isWithinWindow(at(2), "01:00", "08:30"), true);
  assert.equal(isWithinWindow(at(8, 29), "01:00", "08:30"), true);
  assert.equal(isWithinWindow(at(8, 30), "01:00", "08:30"), false, "the end is exclusive");
  assert.equal(isWithinWindow(at(0, 59), "01:00", "08:30"), false);
  assert.equal(isWithinWindow(at(20), "01:00", "08:30"), false);
});

test("a window crossing midnight works, which is the one people set", () => {
  // Treated as a simple range this would never open.
  assert.equal(isWithinWindow(at(23), "22:00", "06:00"), true);
  assert.equal(isWithinWindow(at(2), "22:00", "06:00"), true);
  assert.equal(isWithinWindow(at(5, 59), "22:00", "06:00"), true);
  assert.equal(isWithinWindow(at(6), "22:00", "06:00"), false);
  assert.equal(isWithinWindow(at(12), "22:00", "06:00"), false);
});

test("an unparseable window does not lock the queue shut", () => {
  assert.equal(isWithinWindow(at(12), "banana", "08:30"), true);
});

test("time until the window reopens accounts for the day rolling over", () => {
  assert.equal(minutesUntilWindow(at(23), "01:00"), 120);
  assert.equal(minutesUntilWindow(at(0, 30), "01:00"), 30);
});

test("the rhythm rests after working its stint, then resumes", () => {
  const cfg = { enabled: true, workMinutes: 10, restMinutes: 5 };
  let state = FRESH_RHYTHM;
  state = advanceRhythm(state, 9 * 60_000, true, cfg, 1_000_000);
  assert.equal(state.restingUntil, null, "still inside the stint");

  state = advanceRhythm(state, 2 * 60_000, true, cfg, 1_100_000);
  assert.ok(state.restingUntil, "stint done, should be resting");
  assert.equal(state.restingUntil, 1_100_000 + 5 * 60_000);

  state = advanceRhythm(state, 1000, false, cfg, 1_200_000);
  assert.ok(state.restingUntil, "rest is not over yet");

  state = advanceRhythm(state, 1000, false, cfg, 1_100_000 + 5 * 60_000 + 1);
  assert.equal(state.restingUntil, null, "rest finished");
  assert.equal(state.workedMs, 0);
});

test("idle time does not count towards the stint", () => {
  const cfg = { enabled: true, workMinutes: 10, restMinutes: 5 };
  const state = advanceRhythm(FRESH_RHYTHM, 60 * 60_000, false, cfg, 0);
  assert.equal(state.workedMs, 0);
});

test("a disabled rhythm never holds anything up", () => {
  const cfg = { enabled: false, workMinutes: 1, restMinutes: 60 };
  const state = advanceRhythm({ workedMs: 999_999, restingUntil: 1 }, 10_000, true, cfg, 0);
  assert.deepEqual(state, FRESH_RHYTHM);
});

test("disk room accounts for both copies existing at once", () => {
  const source = 10 * 1024 ** 3;
  const headroom = 20 * 1024 ** 3;
  // The encode is written beside the original, so the worst case is needing
  // room for a second copy no smaller than the first.
  assert.equal(hasDiskRoom(35 * 1024 ** 3, source, headroom), true);
  assert.equal(hasDiskRoom(25 * 1024 ** 3, source, headroom), false);
  assert.equal(hasDiskRoom(30 * 1024 ** 3, source, headroom), true, "exactly enough is enough");
});

test("the defaults protect without needing configuration", () => {
  // Thermal and playback matter on a machine that also serves media; the
  // scheduling ones are opt-in because they stop work happening.
  assert.equal(DEFAULT_GOVERNORS.thermal.enabled, true);
  assert.equal(DEFAULT_GOVERNORS.playback.enabled, true);
  assert.equal(DEFAULT_GOVERNORS.disk.enabled, true);
  // 20 GB of headroom blocked a 6 MB file on a drive with 20 GB spare.
  assert.equal(DEFAULT_GOVERNORS.disk.headroomBytes, 5 * 1024 ** 3);
  assert.equal(DEFAULT_GOVERNORS.window.enabled, false);
  assert.equal(DEFAULT_GOVERNORS.rhythm.enabled, false);
});

test("a single thermal spike does not suspend an encode", () => {
  // Real readings from the target host while encoding: 38, 19, 3, 0 across
  // fifteen seconds, on a machine pmset reported as not throttled. Reacting to
  // any of those cut a real encode to a third of its speed.
  assert.equal(isThrottling([38, 19, 3, 0], 80, 100), false);
  assert.equal(isThrottling([95, 12, 90, 4], 80, 100), false, "alternating spikes are still noise");
});

test("the OS actually cutting the CPU is believed immediately", () => {
  // CPU_Speed_Limit below 100 is not a guess, it is the OS saying so.
  assert.equal(isThrottling([0, 0, 0, 0], 80, 70), true);
  assert.equal(isThrottling([], 80, 50), true);
});

test("too few samples means no verdict yet", () => {
  assert.equal(isThrottling([99, 99], 80, null), false);
  assert.equal(isThrottling([99, 99, 99, 99], 80, null), true);
});

test("the level reading is ignored by default", () => {
  // Measured over a real encode: median 100, while the OS reported
  // CPU_Speed_Limit 100 throughout. It tracks load, not throttling.
  assert.equal(DEFAULT_GOVERNORS.thermal.maxLevel, null);
  assert.equal(isThrottling([100, 100, 100, 100], null, 100), false,
    "a pegged level with no OS throttling must not stop work");
  assert.equal(isThrottling([100, 100, 100, 100], null, 60), true,
    "but the OS cutting the CPU still does");
});

test("the level can still be opted into", () => {
  assert.equal(isThrottling([95, 92, 88, 90], 80, 100), true);
  assert.equal(isThrottling([38, 19, 3, 0], 80, 100), false);
});
