import { useRef } from "react";
import type { Job } from "../shared/job.ts";
import { bytes } from "./format.ts";
import { FileName } from "./FileName.tsx";

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

export function JobPanel({
  job, onAccept, onDiscard, onCancel, onDismiss,
}: {
  job: Job;
  onAccept: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const encoding = job.state === "encoding";
  const verifying = job.state === "verifying";
  const running = encoding || verifying;
  const progress = job.progress;
  const pct = progress?.fraction === null || progress?.fraction === undefined ? null : progress.fraction * 100;
  // ffmpeg stops advancing out_time while it finalises the mux, so the ETA
  // legitimately goes unknown at the very end. Say so, rather than "measuring".
  const nearlyDone = (progress?.fraction ?? 0) > 0.97;

  // ffmpeg's reported position can sit still and then jump; it must never be
  // seen to go backwards, which reads as a fault rather than as reporting.
  const highWater = useRef(0);
  if (!running) highWater.current = 0;
  if (pct !== null && pct > highWater.current) highWater.current = pct;
  const shown = pct === null ? null : Math.max(pct, highWater.current);

  return (
    <section className={`job job-${job.state}`} aria-live="polite">
      <div className="jhead">
        <span className={`jstate ${job.state}`}>{stateLabel(job.state)}</span>
        <span className="jname" title={job.path}><FileName name={job.name} tailLength={22} /></span>
        <span className="spacer" />
        {running && <button className="jbtn" onClick={onCancel}>Cancel</button>}
        {!running && <button className="jbtn quiet" onClick={onDismiss}>Dismiss</button>}
      </div>

      {encoding && (
        <div className="jprogress">
          <div className="bar">
            <i style={{ width: `${shown ?? 0}%` }} />
          </div>
          <div className="jstats">
            <span>{shown === null ? "working" : `${shown.toFixed(1)}%`}</span>
            <span>{progress ? `${progress.fps.toFixed(0)} fps` : "—"}</span>
            <span>{progress ? `${progress.speed.toFixed(2)}× realtime` : "—"}</span>
            <span>{progress ? bytes(progress.outputBytes) : "—"} written</span>
            <span className="eta">
              {progress?.etaSec != null
                ? `${clock(progress.etaSec)} left`
                : nearlyDone
                  ? "finishing the file"
                  : "measuring throughput"}
            </span>
          </div>
        </div>
      )}

      {verifying && job.stage && (
        <div className="jprogress">
          <div className="bar verify">
            <i style={{ width: `${stagePercent(job.stage)}%` }} />
          </div>
          <div className="jstats">
            <span>Check {job.stage.step} of {job.stage.steps}</span>
            <span className="eta">{job.stage.label}</span>
            {job.stage.fraction !== null && <span>{Math.round(job.stage.fraction * 100)}% of this check</span>}
            <span className="jhint">Encoding is done — nothing is replaced until these pass.</span>
          </div>
        </div>
      )}

      <p className="jmessage">{job.message}</p>

      {job.result && job.result.checks.length > 0 && (
        <div className="jchecks">
          {job.result.checks.map((check) => (
            <div className={`jcheck ${check.status}`} key={check.id}>
              <span className="cs">{check.status}</span>
              <span className="cl">{check.label}</span>
              <span className="cd">{check.detail}</span>
            </div>
          ))}
        </div>
      )}

      {job.state === "review" && job.result?.pendingPath && (
        <div className="jactions">
          <button className="jbtn go" onClick={onAccept}>Accept and replace</button>
          <button className="jbtn" onClick={onDiscard}>Discard encode</button>
          <span className="spacer" />
          <span className="jnote">
            The original is untouched. Accepting swaps it in under the identical filename and keeps the
            original in quarantine for 14 days.
          </span>
        </div>
      )}

      {job.result?.command && job.result.command.length > 0 && (
        <details className="jcmd">
          <summary>ffmpeg command · {job.result.encoder} · {job.result.ffmpegVersion}</summary>
          <code>{job.result.command.join(" ")}</code>
        </details>
      )}
    </section>
  );
}

/** Overall verification progress: whole steps plus the current step's own. */
function stagePercent(stage: NonNullable<Job["stage"]>): number {
  const each = 100 / stage.steps;
  return Math.min(100, (stage.step - 1) * each + each * (stage.fraction ?? 0));
}

function stateLabel(state: Job["state"]): string {
  switch (state) {
    case "encoding": return "Encoding";
    case "verifying": return "Verifying";
    case "review": return "Ready for you";
    case "replaced": return "Replaced";
    case "failed": return "Failed";
    case "cancelled": return "Stopped";
  }
}
