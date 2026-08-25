import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { runJob, freshProbe } from "./pipeline.ts";
import { replaceInPlace } from "./replace.ts";
import { assess } from "./classify.ts";
import type { Store, QueueRow } from "./db.ts";
import type { Integrations } from "./integrations.ts";
import type { Governors } from "./governors.ts";
import type { Encode } from "./encoder.ts";
import type { Root, Probe } from "../shared/types.ts";
import type { Preset } from "../shared/preset.ts";
import type { Check } from "../shared/check.ts";
import { keepEverything, planFor, estimateBytes, type Selection } from "../shared/estimate.ts";
import { formatBytes } from "../shared/format.ts";
import type { QueueItem, QueueSnapshot, QueueState } from "../shared/queue.ts";
import type { Progress } from "./encoder.ts";
import type { JobStage } from "../shared/job.ts";

export interface QueueDeps {
  store: Store;
  integrations: Integrations;
  governors: Governors;
  roots: Root[];
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
}

/**
 * Drains the queue one job at a time.
 *
 * Concurrency is fixed at one: measured on the target host, two parallel
 * hardware encodes aggregate less throughput than a single one, and software
 * x265 already saturates every core.
 */
export class Queue {
  private deps: QueueDeps;
  private listeners = new Set<(snapshot: QueueSnapshot) => void>();
  private controller: AbortController | null = null;
  private runningId: string | null = null;
  private live: { progress: Progress | null; stage: JobStage | null } = { progress: null, stage: null };
  private paused = false;
  private draining = false;
  private encode: Encode | null = null;
  private heldBy: string | null = null;
  private holdReason: string | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(deps: QueueDeps) {
    this.deps = deps;
    // A row still marked running means the process died mid-encode.
    const requeued = this.deps.store.requeueInterrupted();
    if (requeued > 0) this.emit();
  }

  // ── reading ──────────────────────────────────────────────────────────

  snapshot(): QueueSnapshot {
    const rows = this.deps.store.listQueue();
    const items = rows.map((row) => this.toItem(row));
    const queued = items.filter((i) => i.state === "queued");
    return {
      items,
      running: !this.paused && this.heldBy === null,
      holdReason: this.paused ? "Paused" : this.holdReason,
      heldBy: this.paused ? "paused" : this.heldBy,
      totals: {
        queued: queued.length,
        sourceBytes: queued.reduce((n, i) => n + i.sourceBytes, 0),
        estimatedBytes: queued.reduce((n, i) => n + (i.estimatedBytes ?? 0), 0),
        // From the conversions ledger, not the rows: replaced files leave the
        // queue, and the running total must survive that.
        savedBytes: this.deps.store.savings().bytes,
      },
    };
  }

  private toItem(row: QueueRow): QueueItem {
    const isRunning = row.id === this.runningId;
    let checks: Check[] = [];
    try {
      checks = JSON.parse(row.checks_json) as Check[];
    } catch {
      checks = [];
    }
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      state: row.state as QueueState,
      position: row.position,
      sourceBytes: row.source_bytes,
      estimatedBytes: row.estimated_bytes,
      savedBytes: row.saved_bytes,
      message: row.message,
      addedAt: row.added_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      checks,
      progress: isRunning ? this.live.progress : null,
      stage: isRunning ? this.live.stage : null,
    };
  }

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  // ── writing ──────────────────────────────────────────────────────────

  /**
   * Queue a set of files. Returns what was added and what was not, rather
   * than failing the whole batch because one file is already in the queue.
   */
  async add(
    entries: { path: string; selection?: Selection }[],
    preset: Preset,
  ): Promise<{ added: number; skipped: { path: string; reason: string }[] }> {
    const skipped: { path: string; reason: string }[] = [];
    let added = 0;

    for (const entry of entries) {
      let probe: Probe;
      try {
        probe = await freshProbe(this.deps.ffprobePath, entry.path);
      } catch (err) {
        skipped.push({ path: entry.path, reason: (err as Error).message });
        continue;
      }

      const assessment = assess(probe);
      if (assessment.blockedReason) {
        skipped.push({ path: entry.path, reason: assessment.blockedReason });
        continue;
      }

      const selection = entry.selection ?? keepEverything(probe);
      const trimsTracks =
        selection.audio.length < probe.audio.length || selection.subtitles.length < probe.subtitles.length;
      // Queueing a file with nothing to do burns an encode to produce a copy
      // that then fails the size gate. Say so at the point of adding instead.
      if (!assessment.videoWork && !assessment.audioWork && !trimsTracks) {
        skipped.push({ path: entry.path, reason: "Nothing to convert — efficient video, compatible audio, no tracks dropped." });
        continue;
      }
      if (!assessment.worthConverting && !trimsTracks) {
        skipped.push({
          path: entry.path,
          reason: "Projected no smaller than the original — not worth the encode.",
        });
        continue;
      }

      const estimated = estimateBytes(probe, planFor(probe), selection, {
        crf: preset.crf,
        maxHeight: preset.maxHeight,
      });

      const ok = this.deps.store.addToQueue({
        id: randomUUID(),
        path: probe.path,
        name: basename(probe.path),
        state: "queued",
        source_bytes: probe.size,
        estimated_bytes: estimated,
        saved_bytes: null,
        message: "Waiting",
        selection_json: JSON.stringify(selection),
        preset_json: JSON.stringify(preset),
        checks_json: "[]",
        pending_path: null,
        added_at: Date.now(),
        started_at: null,
        finished_at: null,
      });

      if (ok) added++;
      else skipped.push({ path: entry.path, reason: "Already in the queue." });
    }

    this.emit();
    void this.drain();
    return { added, skipped };
  }

  remove(id: string): boolean {
    const row = this.deps.store.getQueueItem(id);
    if (!row) return false;
    if (row.state === "running") {
      this.cancelRunning();
      return true;
    }
    // A held encode still on disk should not be orphaned by removing the row.
    if (row.pending_path && existsSync(row.pending_path)) rmSync(row.pending_path, { force: true });
    const removed = this.deps.store.removeQueueItem(id);
    this.emit();
    return removed;
  }

  reorder(ids: string[]): void {
    this.deps.store.reorderQueue(ids);
    this.emit();
  }

  clearFinished(): number {
    const n = this.deps.store.clearFinishedQueue();
    this.emit();
    return n;
  }

  pause(): void {
    this.paused = true;
    this.emit();
  }

  /** Current governor state, for the UI. */
  async governorStatus() {
    return this.deps.governors.evaluate();
  }

  resume(): void {
    this.paused = false;
    this.encode?.resume();
    this.emit();
    void this.drain();
  }

  cancelRunning(): void {
    this.controller?.abort();
  }

  /**
   * Stop cleanly on the way out.
   *
   * Killing the server left its ffmpeg orphaned: it carried on encoding for
   * as long as the file took, competing with the replacement server for the
   * same six cores and writing to a temp file nobody would ever collect.
   */
  shutdown(): void {
    this.paused = true;
    this.stopRecheck();
    this.controller?.abort();
    // abort() resumes a suspended process first, then kills it; belt and
    // braces in case the job was mid-suspend when the signal arrived.
    this.encode?.resume();
    this.encode = null;
  }

  /** Accept a held encode: swap it in without re-encoding. */
  accept(id: string): void {
    const row = this.deps.store.getQueueItem(id);
    if (!row) throw new Error("No such item.");
    if (row.state !== "review" || !row.pending_path) throw new Error("Nothing waiting to be accepted.");
    if (!existsSync(row.pending_path)) throw new Error("The encoded file has gone — run it again.");

    const record = replaceInPlace(row.path, row.pending_path, this.deps.roots);
    const saved = record.originalSize - record.newSize;
    this.deps.store.recordConversion({
      path: row.path,
      convertedAt: record.replacedAt,
      originalSize: record.originalSize,
      newSize: record.newSize,
      encoder: "accepted",
      vmaf: null,
      ffmpegVersion: this.deps.ffmpegVersion,
      quarantinePath: record.quarantinePath,
    });
    // Off the list: the queue should show what still needs attention, not a
    // growing history of things that went fine. The ledger keeps the record.
    void this.notify(id, row.path, `Replaced after review, ${formatBytes(saved)} saved.`);
    this.deps.store.removeQueueItem(id);
    this.emit();
  }

  /**
   * Accept every held encode that actually shrank its file.
   *
   * Deliberately not "accept everything": eleven of forty-eight episodes in
   * one run produced larger files, and swallowing those in a bulk action is
   * exactly the mistake a bulk action makes easy. Those stay individual
   * decisions.
   */
  acceptAll(): { accepted: number; skipped: { name: string; reason: string }[] } {
    const skipped: { name: string; reason: string }[] = [];
    let accepted = 0;

    for (const row of this.deps.store.listQueue()) {
      if (row.state !== "review" || !row.pending_path) continue;
      if ((row.saved_bytes ?? 0) <= 0) {
        skipped.push({ name: row.name, reason: "would make the file bigger" });
        continue;
      }
      try {
        this.accept(row.id);
        accepted++;
      } catch (err) {
        skipped.push({ name: row.name, reason: (err as Error).message });
      }
    }
    this.emit();
    return { accepted, skipped };
  }

  /** Throw a held encode away and keep the original. */
  discard(id: string): void {
    const row = this.deps.store.getQueueItem(id);
    if (!row) throw new Error("No such item.");
    if (row.pending_path && existsSync(row.pending_path)) rmSync(row.pending_path, { force: true });
    this.deps.store.updateQueueItem(id, {
      state: "cancelled",
      pending_path: null,
      message: "Encode discarded. The original is untouched.",
      finished_at: Date.now(),
    });
    this.emit();
  }

  /**
   * Tell the library managers the file changed. Deliberately not awaited by
   * the worker: the swap is already done and verified, so a Radarr that is
   * down must not hold up the next encode or mark the job failed.
   */
  private async notify(id: string, path: string, baseMessage: string): Promise<void> {
    if (!this.deps.integrations.anyConfigured) return;
    const outcomes = await this.deps.integrations.afterReplace(path);
    if (outcomes.length === 0) return;
    const failed = outcomes.filter((o) => !o.ok);
    const suffix = failed.length === 0
      ? ` ${outcomes.map((o) => o.service).join(", ")} updated.`
      : ` Could not tell ${failed.map((o) => `${o.service} (${o.detail})`).join(", ")} — rescan by hand.`;
    this.deps.store.updateQueueItem(id, { message: baseMessage + suffix });
    this.emit();
  }

  // ── the worker ───────────────────────────────────────────────────────

  /**
   * Start work if there is any, nothing is running, and every governor agrees.
   *
   * When a governor says no the loop stops rather than spinning: a timer
   * re-checks, so an overnight window or a cooling-off period costs nothing
   * while it waits.
   */
  async drain(): Promise<void> {
    if (this.draining || this.paused || this.runningId) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.paused) break;
        const row = this.deps.store.nextQueued();
        if (!row) {
          this.setHold(null, null);
          break;
        }

        const status = await this.deps.governors.evaluate({ path: row.path, sourceBytes: row.source_bytes });
        if (!status.verdict.allowed) {
          this.setHold(status.verdict.governor, status.verdict.reason);
          this.scheduleRecheck();
          break;
        }
        this.setHold(null, null);
        await this.runOne(row);
      }
    } finally {
      this.draining = false;
    }
  }

  private setHold(governor: string | null, reason: string | null): void {
    if (this.heldBy === governor && this.holdReason === reason) return;
    this.heldBy = governor;
    this.holdReason = reason;
    this.emit();
  }

  /** Poll while held, so the queue restarts itself without anyone clicking. */
  private scheduleRecheck(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      this.deps.governors.tick(false);
      if (this.paused || this.runningId) return;
      if (!this.deps.store.nextQueued()) {
        this.stopRecheck();
        this.setHold(null, null);
        return;
      }
      void this.drain().then(() => {
        if (this.heldBy === null) this.stopRecheck();
      });
    }, 30_000);
    // Never keep the process alive just to poll.
    this.watchdog.unref?.();
  }

  private stopRecheck(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * While a job runs, keep asking. A governor that turns hostile mid-encode
   * suspends the process rather than killing it — SIGSTOP costs nothing and
   * loses no work, which is what makes checking every few seconds reasonable.
   */
  private startSupervising(): ReturnType<typeof setInterval> {
    let suspended = false;
    const timer = setInterval(() => {
      void (async () => {
        if (!this.encode) return;
        this.deps.governors.tick(!suspended);
        const status = await this.deps.governors.evaluate();
        if (!status.verdict.allowed && !suspended) {
          suspended = this.encode.pause();
          if (suspended) this.setHold(status.verdict.governor, `${status.verdict.reason} — encode suspended`);
        } else if (status.verdict.allowed && suspended) {
          this.encode.resume();
          suspended = false;
          this.setHold(null, null);
        }
      })();
    }, 15_000);
    timer.unref?.();
    return timer;
  }

  private async runOne(row: QueueRow): Promise<void> {
    this.runningId = row.id;
    this.controller = new AbortController();
    this.live = { progress: null, stage: null };
    this.deps.store.updateQueueItem(row.id, { state: "running", started_at: Date.now(), message: "Starting" });
    this.emit();

    try {
      const probe = await freshProbe(this.deps.ffprobePath, row.path);
      const selection = JSON.parse(row.selection_json) as Selection;
      const preset = JSON.parse(row.preset_json) as Preset;

      const supervisor = this.startSupervising();
      const result = await runJob({
        probe,
        selection,
        preset,
        roots: this.deps.roots,
        ffmpegPath: this.deps.ffmpegPath,
        ffprobePath: this.deps.ffprobePath,
        ffmpegVersion: this.deps.ffmpegVersion,
        signal: this.controller.signal,
        onProgress: (progress) => {
          this.live = { progress, stage: null };
          this.emit();
        },
        onStage: (stage) => {
          this.live = { ...this.live, stage };
          this.emit();
        },
        onEncodeStart: (encode) => { this.encode = encode; },
      });
      clearInterval(supervisor);
      this.encode = null;

      const state: QueueState =
        result.outcome === "replaced" ? "done"
        : result.outcome === "review" ? "review"
        : result.outcome === "cancelled" ? "cancelled"
        : "failed";

      // On review the encode exists but nothing has been swapped, so measure
      // the file we are holding: the real change has to be visible *before*
      // anyone accepts it, not after.
      let saved: number | null = result.record ? result.record.originalSize - result.record.newSize : null;
      if (saved === null && result.pendingPath && existsSync(result.pendingPath)) {
        try {
          saved = probe.size - statSync(result.pendingPath).size;
        } catch {
          saved = null;
        }
      }
      if (result.record) {
        this.deps.store.recordConversion({
          path: probe.path,
          convertedAt: result.record.replacedAt,
          originalSize: result.record.originalSize,
          newSize: result.record.newSize,
          encoder: result.encoder,
          vmaf: result.vmaf,
          ffmpegVersion: result.ffmpegVersion,
          quarantinePath: result.record.quarantinePath,
        });
      }

      this.deps.store.updateQueueItem(row.id, {
        state,
        message: result.message,
        checks_json: JSON.stringify(result.checks),
        pending_path: result.pendingPath,
        saved_bytes: saved,
        finished_at: Date.now(),
      });

      if (state === "done") {
        void this.notify(row.id, probe.path, result.message);
        // Same reasoning as accept: a replaced file needs nothing from you.
        this.deps.store.removeQueueItem(row.id);
        this.emit();
        return;
      }
    } catch (err) {
      this.deps.store.updateQueueItem(row.id, {
        state: "failed",
        message: `${(err as Error).message} — the original was not touched.`,
        finished_at: Date.now(),
      });
    } finally {
      this.runningId = null;
      this.controller = null;
      this.encode = null;
      this.live = { progress: null, stage: null };
      this.emit();
    }
  }
}
