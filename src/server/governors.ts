import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import {
  ALLOWED, advanceRhythm, hasDiskRoom, isWithinWindow, minutesUntilWindow,
  FRESH_RHYTHM, type GovernorConfig, type GovernorVerdict, type RhythmState,
} from "../shared/governors.ts";
import { formatBytes } from "../shared/format.ts";
import type { PlexConfig } from "./integrations.ts";

const run = promisify(execFile);

export interface ThermalReading {
  /** 0 means not throttling; higher means the chip is pulling its own clocks down. */
  level: number;
  source: string;
  available: boolean;
}

/**
 * How hot the machine says it is.
 *
 * Intel Macs expose a thermal level directly. `pmset -g therm` reports a
 * speed limit below 100 when the CPU is being held back, which is the same
 * signal from the other side. Load average is deliberately not used: during
 * an encode it is pinned by design and says nothing about heat.
 */
export async function readThermal(): Promise<ThermalReading> {
  try {
    const { stdout } = await run("/usr/sbin/sysctl", ["-n", "machdep.xcpm.cpu_thermal_level"], { timeout: 4000 });
    const level = Number(stdout.trim());
    if (Number.isFinite(level)) return { level, source: "machdep.xcpm.cpu_thermal_level", available: true };
  } catch {
    /* Apple Silicon, or the oid is gone */
  }
  try {
    const { stdout } = await run("/usr/bin/pmset", ["-g", "therm"], { timeout: 4000 });
    const match = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(stdout);
    if (match) {
      const limit = Number(match[1]);
      // 100 is unrestricted; treat each 10% of lost headroom as a level.
      return { level: Math.max(0, Math.round((100 - limit) / 10)), source: "pmset CPU_Speed_Limit", available: true };
    }
  } catch {
    /* pmset unavailable */
  }
  return { level: 0, source: "no thermal sensor available", available: false };
}

export interface PlaybackReading {
  streams: number;
  available: boolean;
}

/** How many people are watching something right now. */
export async function readPlayback(plex: PlexConfig | null, timeoutMs = 5000): Promise<PlaybackReading> {
  if (!plex) return { streams: 0, available: false };
  try {
    const url = `${plex.url.replace(/\/+$/, "")}/status/sessions`;
    const response = await fetch(url, {
      headers: { "X-Plex-Token": plex.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { streams: 0, available: false };
    const body = (await response.json()) as { MediaContainer?: { size?: number } };
    return { streams: Number(body?.MediaContainer?.size ?? 0), available: true };
  } catch {
    // Unreachable is not "nobody is watching", but it must not stop the queue
    // forever either. Treat it as unknown and carry on.
    return { streams: 0, available: false };
  }
}

export interface GovernorStatus {
  verdict: GovernorVerdict;
  thermal: ThermalReading;
  playback: PlaybackReading;
  rhythm: RhythmState;
}

/**
 * Consults every governor and reports the first one that says no.
 *
 * Order is deliberate: the cheap local checks run before anything that hits
 * the network, and the reason shown is the one the user can act on soonest.
 */
export class Governors {
  private config: GovernorConfig;
  private plex: PlexConfig | null;
  private rhythm: RhythmState = FRESH_RHYTHM;
  private lastTick = Date.now();
  private lastThermal: ThermalReading = { level: 0, source: "not read yet", available: false };
  private lastPlayback: PlaybackReading = { streams: 0, available: false };

  constructor(config: GovernorConfig, plex: PlexConfig | null) {
    this.config = config;
    this.plex = plex;
  }

  setConfig(config: GovernorConfig): void {
    this.config = config;
  }

  get current(): GovernorConfig {
    return this.config;
  }

  /** Advance the work/rest clock. Call regularly with whether work happened. */
  tick(working: boolean, now = Date.now()): void {
    this.rhythm = advanceRhythm(this.rhythm, now - this.lastTick, working, this.config.rhythm, now);
    this.lastTick = now;
  }

  /**
   * May the queue work? `sourceBytes` is the file about to start, so the disk
   * guard can be specific; omit it for a general check.
   */
  async evaluate(input: { path?: string; sourceBytes?: number } = {}, now = new Date()): Promise<GovernorStatus> {
    const verdict = await this.decide(input, now);
    return { verdict, thermal: this.lastThermal, playback: this.lastPlayback, rhythm: this.rhythm };
  }

  private async decide(input: { path?: string; sourceBytes?: number }, now: Date): Promise<GovernorVerdict> {
    if (this.config.window.enabled && !isWithinWindow(now, this.config.window.from, this.config.window.to)) {
      const wait = minutesUntilWindow(now, this.config.window.from);
      return {
        allowed: false,
        governor: "window",
        reason: `Outside the working window (${this.config.window.from}–${this.config.window.to})`
          + (wait === null ? "" : ` — opens in ${formatMinutes(wait)}`),
      };
    }

    if (this.config.rhythm.enabled && this.rhythm.restingUntil !== null) {
      const left = Math.max(0, Math.round((this.rhythm.restingUntil - now.getTime()) / 60_000));
      return { allowed: false, governor: "rhythm", reason: `Resting between batches — back in ${formatMinutes(left)}` };
    }

    if (this.config.disk.enabled && input.path && input.sourceBytes) {
      const free = freeBytesFor(input.path);
      if (free !== null && !hasDiskRoom(free, input.sourceBytes, this.config.disk.headroomBytes)) {
        // Both figures can round to the same string, which reads as a
        // contradiction, so say how far short it is.
        const needed = input.sourceBytes + this.config.disk.headroomBytes;
        return {
          allowed: false,
          governor: "disk",
          reason:
            `Not enough room on that drive — ${formatBytes(free)} free, ` +
            `needs ${formatBytes(needed)} (${formatBytes(needed - free)} short)`,
        };
      }
    }

    if (this.config.thermal.enabled) {
      this.lastThermal = await readThermal();
      if (this.lastThermal.available && this.lastThermal.level > this.config.thermal.maxLevel) {
        return {
          allowed: false,
          governor: "thermal",
          reason: `The CPU is throttling (level ${this.lastThermal.level}) — letting it cool`,
        };
      }
    }

    if (this.config.playback.enabled && this.plex) {
      this.lastPlayback = await readPlayback(this.plex);
      if (this.lastPlayback.available && this.lastPlayback.streams > 0) {
        const n = this.lastPlayback.streams;
        return {
          allowed: false,
          governor: "playback",
          reason: `${n} ${n === 1 ? "person is" : "people are"} watching — paused until they finish`,
        };
      }
    }

    return ALLOWED;
  }
}

function freeBytesFor(path: string): number | null {
  try {
    const fs = statfsSync(dirname(path));
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
