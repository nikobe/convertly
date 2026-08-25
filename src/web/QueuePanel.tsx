import { useState } from "react";
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

/** Rows visible before it needs expanding. */
const COMPACT_ROWS = 4;

const LABEL: Record<QueueItem["state"], string> = {
  queued: "Waiting",
  running: "Working",
  review: "Needs you",
  done: "Replaced",
  failed: "Failed",
  cancelled: "Stopped",
};

export function QueuePanel({
  snapshot, onAcceptAll, onPause, onResume, onRemove, onAccept, onDiscard, onClear, onClose,
}: {
  snapshot: QueueSnapshot;
  onAcceptAll: () => void;
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

  // Compact by default: a queue is something you glance at, and it should not
  // take the browser over. Only worth expanding once there is more than fits.
  const [expanded, setExpanded] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const overflows = items.length > COMPACT_ROWS;

  const reviews = items.filter((i) => i.state === "review");
  const acceptable = reviews.filter((i) => (i.savedBytes ?? 0) > 0);
  const wouldGrow = reviews.length - acceptable.length;

  return (
    <section className={`queue${expanded ? " tall" : ""}`} aria-label="Conversion queue">
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
        {acceptable.length > 1 && (
          <button
            className="jbtn go"
            onClick={() => {
              // Replacing this many originals in one click deserves a beat,
              // the same as the downscale control.
              if (!confirmAll) { setConfirmAll(true); return; }
              setConfirmAll(false);
              onAcceptAll();
            }}
            title={
              wouldGrow > 0
                ? `${wouldGrow} would make the file bigger and are left for you`
                : "Replace the originals for every checked encode"
            }
          >
            {confirmAll
              ? `Replace ${acceptable.length}? Click again`
              : `Accept all ${acceptable.length}`}
          </button>
        )}
        {finished > 0 && <button className="jbtn quiet" onClick={onClear}>Clear {finished} finished</button>}
        {overflows && (
          <button
            className="jbtn quiet"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Back to a few rows" : `Show all ${items.length}`}
          >
            {expanded ? "Collapse" : `Expand · ${items.length}`}
          </button>
        )}
        <button className="jbtn quiet" onClick={onClose}>Close</button>
      </div>

      {wouldGrow > 0 && (
        <p className="qwarnrow">
          {wouldGrow} of these came out <strong>bigger</strong> than the original — left out of
          Accept all, decide on those yourself.
        </p>
      )}

      {!running && (
        <p className={`qpaused${snapshot.heldBy && snapshot.heldBy !== "paused" ? " governed" : ""}`}>
          {snapshot.heldBy === "paused" || !snapshot.holdReason
            ? "Paused. The job that was running finishes; nothing new starts until you resume."
            : `Holding — ${snapshot.holdReason}. It starts again on its own.`}
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

/**
 * The change in size, as a percentage.
 *
 * The message beside it already carries the megabytes, so repeating them here
 * was noise — and a negative saving rendered as "−-6.1 MB", which reads as a
 * saving at a glance. A file that grew now says so in red.
 */
function Delta({ saved, source }: { saved: number; source: number }) {
  const percent = (saved / source) * 100;
  const grew = percent < 0;
  return (
    <span
      className={grew ? " qgrew" : " qsaved"}
      title={grew
        ? `${bytes(-saved)} bigger than the original`
        : `${bytes(saved)} smaller than the original`}
    >
      {" "}
      {grew ? "+" : "−"}
      {Math.abs(percent).toFixed(percent !== 0 && Math.abs(percent) < 10 ? 1 : 0)}%
    </span>
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
        {item.savedBytes !== null && item.savedBytes !== undefined && item.sourceBytes > 0 ? (
          <Delta saved={item.savedBytes} source={item.sourceBytes} />
        ) : item.estimatedBytes ? (
          <span className="qest"> → {bytes(item.estimatedBytes)}</span>
        ) : null}
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
