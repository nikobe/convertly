import type { QueueItem, QueueSnapshot } from "../shared/queue.ts";
import { FileName } from "./FileName.tsx";
import { bytes } from "./format.ts";

function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

const LABEL: Record<QueueItem["state"], string> = {
  queued: "Waiting",
  running: "Working",
  review: "Needs you",
  done: "Replaced",
  failed: "Failed",
  cancelled: "Stopped",
};

export function QueuePanel({
  snapshot, onPause, onResume, onRemove, onAccept, onDiscard, onClear, onClose,
}: {
  snapshot: QueueSnapshot;
  onPause: () => void;
  onResume: () => void;
  onRemove: (id: string) => void;
  onAccept: (id: string) => void;
  onDiscard: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { items, totals, running } = snapshot;
  const finished = items.filter((i) => ["done", "failed", "cancelled"].includes(i.state)).length;
  const active = items.find((i) => i.state === "running");

  return (
    <section className="queue" aria-label="Conversion queue">
      <div className="qhead">
        <h2>Queue</h2>
        <span className="qsub">
          {totals.queued} waiting
          {totals.queued > 0 && ` · ${bytes(totals.estimatedBytes)} projected from ${bytes(totals.sourceBytes)}`}
          {totals.savedBytes > 0 && ` · ${bytes(totals.savedBytes)} recovered so far`}
        </span>
        <span className="spacer" />
        {running
          ? <button className="jbtn" onClick={onPause} disabled={!active && totals.queued === 0}>Pause</button>
          : <button className="jbtn go" onClick={onResume}>Resume</button>}
        {finished > 0 && <button className="jbtn quiet" onClick={onClear}>Clear {finished} finished</button>}
        <button className="jbtn quiet" onClick={onClose}>Close</button>
      </div>

      {!running && (
        <p className="qpaused">
          Paused. The job that was running finishes; nothing new starts until you resume.
        </p>
      )}

      {items.length === 0 && (
        <p className="qempty">Nothing queued. Select files in the browser and add them.</p>
      )}

      <div className="qlist">
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            onRemove={() => onRemove(item.id)}
            onAccept={() => onAccept(item.id)}
            onDiscard={() => onDiscard(item.id)}
          />
        ))}
      </div>
    </section>
  );
}

function Row({
  item, onRemove, onAccept, onDiscard,
}: {
  item: QueueItem;
  onRemove: () => void;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const p = item.progress;
  const stage = item.stage;
  const pct = stage
    ? ((stage.step - 1) / stage.steps + (stage.fraction ?? 0) / stage.steps) * 100
    : (p?.fraction ?? 0) * 100;

  return (
    <div className={`qitem ${item.state}`}>
      <span className={`qstate ${item.state}`}>{LABEL[item.state]}</span>
      <span className="qname" title={item.path}><FileName name={item.name} tailLength={20} /></span>
      <span className="qsize">
        {bytes(item.sourceBytes)}
        {item.savedBytes ? <span className="qsaved"> −{bytes(item.savedBytes)}</span>
          : item.estimatedBytes ? <span className="qest"> → {bytes(item.estimatedBytes)}</span> : null}
      </span>

      {item.state === "running" && (
        <div className="qbar">
          <i className={stage ? "verify" : ""} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {item.state === "running" && (
        <span className="qwhen">
          {stage ? stage.label : p?.etaSec != null ? `${clock(p.etaSec)} left` : "measuring"}
        </span>
      )}

      {item.state !== "running" && <span className="qmsg" title={item.message}>{item.message}</span>}

      <span className="qbtns">
        {item.state === "review" && (
          <>
            <button className="jbtn go" onClick={onAccept}>Accept</button>
            <button className="jbtn" onClick={onDiscard}>Discard</button>
          </>
        )}
        {(item.state === "queued" || item.state === "running") && (
          <button className="jbtn quiet" onClick={onRemove}>
            {item.state === "running" ? "Cancel" : "Remove"}
          </button>
        )}
      </span>
    </div>
  );
}
