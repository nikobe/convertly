/**
 * Rules that decide when the queue may work.
 *
 * Each is independent and each can be switched off. The pure decisions live
 * here so they are testable without a clock, a thermometer or a media server.
 */

export interface GovernorConfig {
  /** Only work between two times of day. */
  window: { enabled: boolean; from: string; to: string };
  /** Work for a while, then idle, so the machine is not pinned all night. */
  rhythm: { enabled: boolean; workMinutes: number; restMinutes: number };
  /** Back off when the CPU reports it is being throttled. */
  thermal: { enabled: boolean; maxLevel: number };
  /** Stop encoding while someone is watching something. */
  playback: { enabled: boolean };
  /** Refuse to start without room for the output. */
  disk: { enabled: boolean; headroomBytes: number };
}

export const DEFAULT_GOVERNORS: GovernorConfig = {
  window: { enabled: false, from: "01:00", to: "08:30" },
  rhythm: { enabled: false, workMinutes: 90, restMinutes: 20 },
  // machdep.xcpm.cpu_thermal_level is an instantaneous reading that swings
  // wildly under load — 38, 19, 3, 0 across fifteen seconds on a machine that
  // pmset reported as not throttled at all. A threshold of 0 suspended a real
  // encode every few seconds and cut it to a third of its speed. So: a high
  // bar, and only when it stays there.
  thermal: { enabled: true, maxLevel: 80 },
  playback: { enabled: true },
  // Enough that a drive is never driven to completely full, which upsets the
  // OS and any media server on it — not so much that a small file is blocked
  // on a drive with plenty of room for it.
  disk: { enabled: true, headroomBytes: 5 * 1024 * 1024 * 1024 },
};

export interface GovernorVerdict {
  /** May the queue work right now? */
  allowed: boolean;
  /** Which governor said no, for the UI. */
  governor: string | null;
  /** Said in a way a person can act on. */
  reason: string | null;
}

export const ALLOWED: GovernorVerdict = { allowed: true, governor: null, reason: null };

/** "01:00" -> minutes past midnight, or null if it is not a time. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is `now` inside the window?
 *
 * Windows normally cross midnight — 01:00 to 08:30 is the easy case, but
 * 22:00 to 06:00 is the one people actually set, and treating it as a simple
 * range would mean it never opened.
 */
export function isWithinWindow(now: Date, from: string, to: string): boolean {
  const start = parseClock(from);
  const end = parseClock(to);
  if (start === null || end === null) return true; // unparseable: do not lock the queue
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Minutes until the window opens again, for telling the user when. */
export function minutesUntilWindow(now: Date, from: string): number | null {
  const start = parseClock(from);
  if (start === null) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start > minutes ? start - minutes : 24 * 60 - minutes + start;
}

export interface RhythmState {
  /** Milliseconds worked since the last rest. */
  workedMs: number;
  /** Epoch ms until which the queue is resting, or null. */
  restingUntil: number | null;
}

export const FRESH_RHYTHM: RhythmState = { workedMs: 0, restingUntil: null };

/**
 * Advance the work/rest cycle.
 *
 * Called with however long has passed since the last tick, so it does not
 * care how often it is polled.
 */
export function advanceRhythm(
  state: RhythmState,
  elapsedMs: number,
  working: boolean,
  config: GovernorConfig["rhythm"],
  now: number,
): RhythmState {
  if (!config.enabled) return FRESH_RHYTHM;

  if (state.restingUntil !== null) {
    return now >= state.restingUntil ? FRESH_RHYTHM : state;
  }
  if (!working) return state;

  const workedMs = state.workedMs + Math.max(0, elapsedMs);
  if (workedMs >= config.workMinutes * 60_000) {
    return { workedMs: 0, restingUntil: now + config.restMinutes * 60_000 };
  }
  return { workedMs, restingUntil: null };
}

/** How many consecutive elevated readings before believing the machine is hot. */
export const THERMAL_SUSTAIN_SAMPLES = 4;

/**
 * Is the machine genuinely throttling?
 *
 * `speedLimit` is the authoritative answer when available — below 100 means
 * the OS is actually holding the CPU back. The level readings are noisy, so
 * they only count when every recent sample is elevated.
 */
export function isThrottling(
  recentLevels: number[],
  maxLevel: number,
  speedLimit: number | null,
): boolean {
  if (speedLimit !== null && speedLimit < 100) return true;
  if (recentLevels.length < THERMAL_SUSTAIN_SAMPLES) return false;
  const window = recentLevels.slice(-THERMAL_SUSTAIN_SAMPLES);
  return window.every((level) => level > maxLevel);
}

/** Enough room for the output plus a margin? */
export function hasDiskRoom(
  freeBytes: number,
  sourceBytes: number,
  headroomBytes: number,
): boolean {
  // The encode is written alongside the original before the swap, so both
  // exist at once and the worst case is the output being no smaller.
  return freeBytes >= sourceBytes + headroomBytes;
}
