import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { runJob, freshProbe, type JobResult } from "./pipeline.ts";
import { replaceInPlace } from "./replace.ts";
import { assess } from "./classify.ts";
import type { Progress } from "./encoder.ts";
import type { Root, Probe } from "../shared/types.ts";
import type { Store } from "./db.ts";
import type { Preset } from "../shared/preset.ts";
import { keepEverything, type Selection } from "../shared/estimate.ts";
import { formatBytes } from "../shared/format.ts";

export type JobState = "encoding" | "verifying" | "review" | "replaced" | "failed" | "cancelled";

export interface Job {
  id: string;
  path: string;
  name: string;
  state: JobState;
  progress: Progress | null;
  result: JobResult | null;
  startedAt: number;
  finishedAt: number | null;
  sourceSize: number;
  message: string;
}

type Listener = (job: Job) => void;

/**
 * Runs one job at a time and reports on it.
 *
 * Concurrency is deliberately 1: measured on the target host, two parallel
 * hardware encodes aggregate less throughput than one, and software x265
 * already saturates every core. Phase 03 makes this list persistent.
 */
export class JobRunner {
  private jobs = new Map<string, Job>();
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private running: string | null = null;

  private readonly deps: {
    roots: Root[];
    ffmpegPath: string;
    ffprobePath: string;
    ffmpegVersion: string;
    store: Store;
  };

  constructor(deps: {
    roots: Root[]; ffmpegPath: string; ffprobePath: string; ffmpegVersion: string; store: Store;
  }) {
    this.deps = deps;
  }

  private remember(path: string, result: JobResult): void {
    if (!result.record) return;
    this.deps.store.recordConversion({
      path,
      convertedAt: result.record.replacedAt,
      originalSize: result.record.originalSize,
      newSize: result.record.newSize,
      encoder: result.encoder,
      vmaf: result.vmaf,
      ffmpegVersion: result.ffmpegVersion,
      quarantinePath: result.record.quarantinePath,
    });
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  get isBusy(): boolean {
    return this.running !== null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(job: Job): void {
    for (const listener of this.listeners) listener(job);
  }

  private update(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
    this.emit(job);
  }

  /**
   * Start a job. `replace` is opt-in: by default the file is encoded and
   * verified but the original is left alone until a person accepts it.
   */
  async start(input: {
    path: string;
    selection?: Selection;
    preset: Preset;
    replace: boolean;
  }): Promise<Job> {
    if (this.running) throw new Error("A job is already running. One at a time on this hardware.");

    const probe = await freshProbe(this.deps.ffprobePath, input.path);
    const assessment = assess(probe);
    if (assessment.blockedReason) {
      throw new Error(`${assessment.blockedReason} Override it deliberately if you really want to.`);
    }

    const id = randomUUID();
    const job: Job = {
      id,
      path: probe.path,
      name: probe.path.split("/").pop() ?? probe.path,
      state: "encoding",
      progress: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
      sourceSize: probe.size,
      message: "Starting…",
    };
    this.jobs.set(id, job);
    this.running = id;
    this.emit(job);

    const controller = new AbortController();
    this.controllers.set(id, controller);

    // Deliberately not awaited: the caller gets the job id straight away and
    // follows progress over SSE.
    void this.execute(id, probe, input, controller);
    return job;
  }

  private async execute(
    id: string,
    probe: Probe,
    input: { selection?: Selection; preset: Preset; replace: boolean },
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await runJob({
        probe,
        selection: input.selection ?? keepEverything(probe),
        preset: input.preset,
        roots: this.deps.roots,
        ffmpegPath: this.deps.ffmpegPath,
        ffprobePath: this.deps.ffprobePath,
        ffmpegVersion: this.deps.ffmpegVersion,
        dryRun: !input.replace,
        signal: controller.signal,
        onProgress: (progress) => this.update(id, { progress, state: "encoding", message: "Encoding" }),
      });

      if (result.outcome === "replaced") this.remember(probe.path, result);

      this.update(id, {
        state: result.outcome === "replaced" ? "replaced" : result.outcome === "review" ? "review" : result.outcome,
        result,
        message: result.message,
        finishedAt: Date.now(),
      });
    } catch (err) {
      this.update(id, {
        state: "failed",
        message: `${(err as Error).message} — the original was not touched.`,
        finishedAt: Date.now(),
      });
    } finally {
      this.controllers.delete(id);
      this.running = null;
    }
  }

  /** Swap in an encode that was held for review. No re-encoding. */
  accept(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job.");
    if (job.state !== "review" || !job.result?.pendingPath) throw new Error("That job has nothing waiting to be accepted.");
    if (!existsSync(job.result.pendingPath)) throw new Error("The encoded file is gone — run it again.");

    const record = replaceInPlace(job.path, job.result.pendingPath, this.deps.roots);
    const saved = record.originalSize - record.newSize;
    job.state = "replaced";
    job.result = { ...job.result, outcome: "replaced", record, pendingPath: null };
    this.remember(job.path, job.result);
    job.message = `Replaced in place, ${formatBytes(saved)} saved. Original kept in quarantine for 14 days.`;
    this.emit(job);
    return job;
  }

  /** Throw the encode away and keep the original as it is. */
  discard(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job.");
    if (job.result?.pendingPath && existsSync(job.result.pendingPath)) {
      rmSync(job.result.pendingPath, { force: true });
    }
    job.state = "cancelled";
    job.result = job.result ? { ...job.result, pendingPath: null } : null;
    job.message = "Encode discarded. The original is untouched.";
    this.emit(job);
    return job;
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }
}
