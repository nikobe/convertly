import type { Check } from "./check.ts";
import type { JobProgress, JobStage } from "./job.ts";

/**
 * A queued conversion.
 *
 * "review" and "done" are both terminal for the worker; review means the
 * encode passed but wants a person before the original is touched.
 */
export type QueueState =
  | "queued"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface QueueItem {
  id: string;
  path: string;
  name: string;
  state: QueueState;
  /** Ordering among queued items. Lower runs first. */
  position: number;
  sourceBytes: number;
  /** Projected output size when queued, for the queue total. */
  estimatedBytes: number | null;
  /** Actual saving once it has run. */
  savedBytes: number | null;
  message: string;
  addedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  checks: Check[];
  /** Live, only on the running item. */
  progress: JobProgress | null;
  stage: JobStage | null;
}

/**
 * Would running this again plausibly do anything different?
 *
 * Most failures are circumstance — the server stopped mid-encode, the disk
 * was busy, or a bug has since been fixed. A few are properties of the file
 * itself and would fail identically forever; offering to retry those wastes
 * an encode to show the same message.
 */
export function isRetryable(message: string): boolean {
  const permanent = [
    /at least one audio track must be kept/i,
    /no video stream/i,
    /ffprobe could not read/i,
    /refusing to encode an unreadable file/i,
    /different volume/i,
    /outside your configured media roots/i,
  ];
  return !permanent.some((pattern) => pattern.test(message));
}

export interface QueueSnapshot {
  items: QueueItem[];
  /** False while the worker is holding off. */
  running: boolean;
  /** Why the worker is not starting anything, when it is not. */
  holdReason: string | null;
  /** Which governor is holding it, for styling and for the header. */
  heldBy: string | null;
  totals: {
    queued: number;
    sourceBytes: number;
    estimatedBytes: number;
    savedBytes: number;
  };
}
