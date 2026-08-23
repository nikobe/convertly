import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrowseResponse, Bookmark, HealthReport, Root, DirEntry } from "../shared/types.ts";
import { api } from "./api.ts";
import { bytes, duration } from "./format.ts";
import { TrackPanel } from "./TrackPanel.tsx";
import { JobPanel } from "./JobPanel.tsx";
import { FileName } from "./FileName.tsx";
import { QualityPanel } from "./QualityPanel.tsx";
import { DEFAULT_PRESET, type Preset } from "../shared/preset.ts";
import type { Job } from "../shared/job.ts";
import { planFor, estimateBytes, keepEverything, type Selection } from "../shared/estimate.ts";

/**
 * Do two files carry the same track layout? Compared by ordered codec,
 * channel count and language, so episodes from one release match while a
 * differently-muxed extra does not.
 */
function sameLayout(a: NonNullable<DirEntry["probe"]>, b: NonNullable<DirEntry["probe"]>): boolean {
  const audio = (p: typeof a) => p.audio.map((t) => `${t.codec}:${t.channels}:${t.language ?? "und"}`).join("|");
  const subs = (p: typeof a) => p.subtitles.map((t) => `${t.codec}:${t.language ?? "und"}`).join("|");
  return audio(a) === audio(b) && subs(a) === subs(b);
}

/** Projection for one file under the track choices currently in force. */
function project(
  entry: DirEntry,
  selection: Selection | undefined,
  preset: Preset,
): { after: number | null; saving: number | null } {
  if (!entry.probe) return { after: null, saving: null };
  const chosen = selection ?? keepEverything(entry.probe);
  const after = estimateBytes(entry.probe, planFor(entry.probe), chosen, {
    crf: preset.crf,
    maxHeight: preset.maxHeight,
  });
  return { after, saving: after === null ? null : Math.max(0, entry.size! - after) };
}

export function App() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [roots, setRoots] = useState<Root[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [listing, setListing] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selections, setSelections] = useState<Map<string, Selection>>(new Map());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [preset, setPreset] = useState<Preset>(DEFAULT_PRESET);
  const [presetLoaded, setPresetLoaded] = useState(false);
  const [presetSaving, setPresetSaving] = useState(false);
  const [showQuality, setShowQuality] = useState(false);

  const go = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.browse(path));
      setSelected(new Set());
      setExpanded(null);
      setSelections(new Map());
      setAnchor(null);
      setNote(null);
    } catch (err) {
      setError((err as Error).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // One live stream for job progress. SSE reconnects on its own.
  useEffect(() => {
    const source = new EventSource("/api/jobs/events");
    source.addEventListener("snapshot", (event) => {
      const all = JSON.parse((event as MessageEvent<string>).data) as Job[];
      const active = all.find((j) => j.state === "encoding" || j.state === "review");
      if (active) setJob(active);
    });
    source.addEventListener("job", (event) => {
      setJob(JSON.parse((event as MessageEvent<string>).data) as Job);
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.roots().then(setRoots).catch(() => setRoots([]));
    api.bookmarks().then(setBookmarks).catch(() => setBookmarks([]));
    api.presets()
      .then(({ active }) => setPreset(active))
      .catch(() => undefined)
      .finally(() => setPresetLoaded(true));
    void go();
  }, [go]);

  /**
   * Quality settings persist server-side, not in the browser.
   *
   * The server is what the queue will read when it runs jobs unattended, so a
   * browser-only copy would be a second source of truth that could disagree
   * with the one actually used. Debounced, because clicking through the
   * quality steps would otherwise fire a write per click.
   */
  useEffect(() => {
    if (!presetLoaded) return;
    setPresetSaving(true);
    const timer = setTimeout(() => {
      api.saveDefaultPreset(preset)
        .catch((err: Error) => setNote(err.message))
        .finally(() => setPresetSaving(false));
    }, 600);
    return () => clearTimeout(timer);
  }, [preset, presetLoaded]);

  const videos = useMemo(() => listing?.entries.filter((e) => e.kind === "video") ?? [], [listing]);
  const actionable = useMemo(
    () => videos.filter((e) => e.assessment && (e.assessment.videoWork || e.assessment.audioWork) && !e.assessment.blockedReason),
    [videos],
  );
  const recoverable = useMemo(
    () =>
      videos
        .filter((e) => selected.has(e.path))
        .reduce((sum, e) => sum + (project(e, selections.get(e.path), preset).saving ?? 0), 0),
    [videos, selected, selections, preset],
  );
  const trimmed = useMemo(() => selections.size, [selections]);

  /**
   * Toggle one row, or with shift held, every selectable row between the last
   * one clicked and this one — the behaviour a 24-episode season needs.
   */
  const toggle = (path: string, range = false) => {
    if (range && anchor) {
      const order = actionable.map((e) => e.path);
      const from = order.indexOf(anchor);
      const to = order.indexOf(path);
      if (from !== -1 && to !== -1) {
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected((prev) => new Set([...prev, ...span]));
        setAnchor(path);
        return;
      }
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
    setAnchor(path);
  };

  const allSelected = actionable.length > 0 && actionable.every((e) => selected.has(e.path));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(actionable.map((e) => e.path)));
    setAnchor(null);
  };

  /**
   * Copy one file's track choices onto every other selected file with the
   * same track layout. Episodes from one release share a layout, so this is
   * the difference between choosing once and choosing 24 times. Files that
   * differ are left alone and reported rather than guessed at.
   */
  const applyTracksToSelection = (sourcePath: string, selection: Selection) => {
    const source = videos.find((e) => e.path === sourcePath);
    if (!source?.probe) return;
    const keptAudioPositions = source.probe.audio
      .map((t, i) => (selection.audio.includes(t.index) ? i : -1))
      .filter((i) => i >= 0);
    const keptSubPositions = source.probe.subtitles
      .map((t, i) => (selection.subtitles.includes(t.index) ? i : -1))
      .filter((i) => i >= 0);

    let applied = 0;
    let skipped = 0;
    const next = new Map(selections);
    for (const entry of videos) {
      if (entry.path === sourcePath || !selected.has(entry.path) || !entry.probe) continue;
      if (!sameLayout(source.probe, entry.probe)) {
        skipped++;
        continue;
      }
      next.set(entry.path, {
        audio: keptAudioPositions.map((i) => entry.probe!.audio[i]!.index),
        subtitles: keptSubPositions.map((i) => entry.probe!.subtitles[i]!.index),
      });
      applied++;
    }
    setSelections(next);
    setNote(
      applied === 0 && skipped === 0
        ? "Select other episodes first, then apply."
        : `Applied to ${applied} file${applied === 1 ? "" : "s"}` +
            (skipped > 0 ? ` · ${skipped} skipped, different track layout` : ""),
    );
  };

  const pin = async () => {
    if (!listing) return;
    const last = listing.trail.at(-1);
    const saved = await api.addBookmark(listing.path, last?.label ?? "Folder");
    setBookmarks((prev) => [...prev.filter((b) => b.id !== saved.id), saved].sort((a, b) => a.label.localeCompare(b.label)));
  };

  const unpin = async (id: number) => {
    await api.removeBookmark(id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  };

  const pinned = listing ? bookmarks.some((b) => b.path === listing.path) : false;
  const busy = job !== null && (job.state === "encoding" || job.state === "verifying");

  const convert = async (path: string, selection: Selection) => {
    setNote(null);
    try {
      setJob(await api.startJob(path, selection, preset, false));
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const jobAction = async (action: "accept" | "discard" | "cancel") => {
    if (!job) return;
    try {
      await api.jobAction(job.id, action);
      if (action !== "cancel") void go(listing?.path);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <div className="app">
      <Hud
        health={health}
        preset={preset}
        saving={presetSaving}
        onOpenQuality={() => setShowQuality((v) => !v)}
      />

      {showQuality && (
        <QualityPanel
          preset={preset}
          onChange={setPreset}
          onClose={() => setShowQuality(false)}
          saving={presetSaving}
        />
      )}

      <div className="body">
        <nav className="rail">
          <div>
            <h2>Drives</h2>
            <div className="group">
              {roots.map((root) => (
                <button
                  key={root.id}
                  className={`link${listing?.rootId === root.id ? " active" : ""}`}
                  onClick={() => go(root.path)}
                >
                  <span className="mk">▸</span>
                  {root.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2>Bookmarks</h2>
            <div className="group">
              {bookmarks.length === 0 && <p className="empty">Open a folder and pin it to keep it here.</p>}
              {bookmarks.map((bm) => (
                <div className="bm" key={bm.id}>
                  <button className="link" onClick={() => go(bm.path)} title={bm.path}>
                    <span className="mk">▪</span>
                    {bm.label}
                  </button>
                  <button className="del" onClick={() => unpin(bm.id)} title={`Remove ${bm.label}`} aria-label={`Remove ${bm.label}`}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </nav>

        <main className="main">
          <div className="crumbs">
            {listing?.parent !== null && listing?.parent !== undefined && (
              <>
                <button onClick={() => go(listing.parent!)} title="Up one folder">↑</button>
                <span className="sep">│</span>
              </>
            )}
            {listing?.trail.map((seg, i) => {
              const last = i === listing.trail.length - 1;
              return (
                <span key={seg.path}>
                  {i > 0 && <span className="sep"> / </span>}
                  {last ? (
                    <span className="here">{seg.label}</span>
                  ) : (
                    <button onClick={() => go(seg.path)}>{seg.label}</button>
                  )}
                </span>
              );
            })}
            <span className="spacer" />
            {listing?.volume && (
              <span className="vol">{bytes(listing.volume.freeBytes)} free</span>
            )}
            {listing && !pinned && (
              <button className="pin" onClick={pin}>+ Pin folder</button>
            )}
            {pinned && <span className="vol">pinned</span>}
          </div>

          <div className="listing">
            {loading && <p className="msg">Scanning<span className="scanning" /></p>}
            {error && <p className="msg error">{error}</p>}
            {!loading && !error && listing && (
              <Listing
                listing={listing}
                selected={selected}
                onToggle={toggle}
                onOpen={go}
                allSelected={allSelected}
                onToggleAll={toggleAll}
                anySelected={selected.size > 0}
                selectedCount={selected.size}
                onApplyTracks={applyTracksToSelection}
                onConvert={convert}
                busy={busy}
                preset={preset}
                expanded={expanded}
                onExpand={(path) => setExpanded((prev) => (prev === path ? null : path))}
                selections={selections}
                onSelectionChange={(path, next) =>
                  setSelections((prev) => new Map(prev).set(path, next))
                }
              />
            )}
          </div>
        </main>
      </div>

      {job && (
        <JobPanel
          job={job}
          onAccept={() => jobAction("accept")}
          onDiscard={() => jobAction("discard")}
          onCancel={() => jobAction("cancel")}
          onDismiss={() => setJob(null)}
        />
      )}

      <footer className="foot">
        <span>
          {videos.length} file{videos.length === 1 ? "" : "s"} · {actionable.length} worth converting
        </span>
        {note && <span className="note">{note}</span>}
        <span className="spacer" />
        <span>
          {trimmed > 0 && <span className="trimmed">{trimmed} retrimmed · </span>}
          {selected.size} selected · <span className="total">{bytes(recoverable)} recoverable</span>
        </span>
        <button className="cta" disabled title="Queueing arrives in phase 02. Phase 01 cannot modify any file.">
          Add to queue — phase 02
        </button>
      </footer>
    </div>
  );
}

function Hud({
  health, preset, saving, onOpenQuality,
}: {
  health: HealthReport | null;
  preset: Preset;
  saving: boolean;
  onOpenQuality: () => void;
}) {
  const [showHealth, setShowHealth] = useState(false);
  const problems = health?.checks.filter((c) => !c.ok) ?? [];
  const ok = health !== null && problems.length === 0;

  return (
    <header className="hud">
      <span className="brand">Convertly</span>

      {/* One summary rather than a chip per check. Eight of them crowded out
          the controls and told you nothing you needed at a glance. */}
      <button
        className={`hstatus${ok ? "" : " bad"}`}
        onClick={() => setShowHealth((v) => !v)}
        aria-expanded={showHealth}
        title={ok ? "Everything reachable" : problems.map((p) => `${p.label}: ${p.detail}`).join("\n")}
      >
        <span className={`dot${ok ? "" : " bad"}`} />
        {health === null ? "Checking" : ok ? "All good" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}
      </button>

      {showHealth && health && (
        <div className="hpanel" role="status">
          {health.checks.map((check) => (
            <div className={`hrow${check.ok ? "" : " bad"}`} key={check.id}>
              <span className={`dot${check.ok ? "" : " bad"}`} />
              <span className="hl">{check.label}</span>
              <span className="hd">{check.detail}</span>
            </div>
          ))}
        </div>
      )}

      <span className="spacer" />
      <button className="qopen" onClick={onOpenQuality} title="Quality settings for the next encode">
        <span className="qlabel">Quality</span>
        <span className="qvalue">
          CRF {preset.crf}
          <span className="qextra"> · {preset.x265Preset}{preset.maxHeight ? ` · ${preset.maxHeight}p` : ""}</span>
        </span>
        {saving && <span className="dirty" aria-label="saving">•</span>}
      </button>
    </header>
  );
}

function Listing({
  listing, selected, onToggle, onOpen, allSelected, onToggleAll, anySelected, selectedCount,
  onApplyTracks, onConvert, busy, preset, expanded, onExpand, selections, onSelectionChange,
}: {
  listing: BrowseResponse;
  selected: Set<string>;
  onToggle: (path: string, range?: boolean) => void;
  onOpen: (path: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
  anySelected: boolean;
  selectedCount: number;
  onApplyTracks: (path: string, selection: Selection) => void;
  onConvert: (path: string, selection: Selection) => void;
  busy: boolean;
  preset: Preset;
  expanded: string | null;
  onExpand: (path: string) => void;
  selections: Map<string, Selection>;
  onSelectionChange: (path: string, next: Selection) => void;
}) {
  if (listing.entries.length === 0) return <p className="msg">This folder is empty.</p>;

  return (
    <table>
      <colgroup>
        <col className="c-pick" />
        <col />
        <col className="c-chips" />
        <col className="c-len" />
        <col className="c-size" />
        <col className="c-after" />
        <col className="c-saves" />
      </colgroup>
      <thead>
        <tr>
          <th className="pick">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = anySelected && !allSelected; }}
              onChange={onToggleAll}
              aria-label={allSelected ? "Deselect all" : "Select everything worth converting"}
              title={allSelected ? "Deselect all" : "Select everything worth converting in this folder"}
              style={{ accentColor: "var(--amber)" }}
            />
          </th>
          <th>Name</th>
          <th>Assessment</th>
          <th className="num">Length</th>
          <th className="num">Size</th>
          <th className="num">After</th>
          <th className="num">Saves</th>
        </tr>
      </thead>
      <tbody>
        {listing.entries.map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            checked={selected.has(entry.path)}
            onToggle={(range) => onToggle(entry.path, range)}
            onOpen={() => onOpen(entry.path)}
            selectedCount={selectedCount}
            onApplyTracks={(sel) => onApplyTracks(entry.path, sel)}
            onConvert={(sel) => onConvert(entry.path, sel)}
            busy={busy}
            preset={preset}
            expanded={expanded === entry.path}
            onExpand={() => onExpand(entry.path)}
            selection={selections.get(entry.path)}
            onSelectionChange={(next) => onSelectionChange(entry.path, next)}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  entry, checked, onToggle, onOpen, selectedCount, onApplyTracks, onConvert, busy, preset,
  expanded, onExpand, selection, onSelectionChange,
}: {
  entry: DirEntry;
  checked: boolean;
  onToggle: (range: boolean) => void;
  onOpen: () => void;
  selectedCount: number;
  onApplyTracks: (selection: Selection) => void;
  onConvert: (selection: Selection) => void;
  busy: boolean;
  preset: Preset;
  expanded: boolean;
  onExpand: () => void;
  selection: Selection | undefined;
  onSelectionChange: (next: Selection) => void;
}) {
  if (entry.kind === "dir") {
    return (
      <tr className="clickable">
        <td className="pick" />
        <td className="name" colSpan={6}>
          <button className="dir" onClick={onOpen} title={entry.name}>▸ <FileName name={entry.name} /></button>
        </td>
      </tr>
    );
  }

  if (entry.kind === "other") {
    return (
      <tr className="idle">
        <td className="pick" />
        <td className="name" title={entry.name}><FileName name={entry.name} /></td>
        <td colSpan={5} />
      </tr>
    );
  }

  const a = entry.assessment;
  const trimmable = Boolean(entry.probe && entry.probe.audio.length + entry.probe.subtitles.length > 1);
  const { after, saving } = project(entry, selection, preset);
  // A file needing no re-encode is still worth queueing once tracks are cut.
  const work = Boolean(a && (a.videoWork || a.audioWork || (selection && saving)) && !a.blockedReason);

  return (
    <>
      <tr className={`${work ? "clickable" : "idle"}${checked ? " sel" : ""}${expanded ? " open" : ""}`}>
        <td className="pick">
          {work && (
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {}}
              onClick={(event) => onToggle(event.shiftKey)}
              aria-label={`Select ${entry.name}`}
              title="Shift-click to select a range"
              style={{ accentColor: "var(--amber)" }}
            />
          )}
        </td>
        <td className="name" title={entry.name}>
          {entry.probe ? (
            <button
              className="expander"
              onClick={onExpand}
              aria-expanded={expanded}
              title={trimmable ? "Show tracks" : "Show details"}
            >
              <span className="caret">{expanded ? "▾" : "▸"}</span>
              <FileName name={entry.name} />
            </button>
          ) : (
            <FileName name={entry.name} />
          )}
        </td>
        <td className="chips">
          {a?.chips.map((chip) => (
            <span className={`chip ${chip.tone}`} key={chip.label} title={chip.title}>{chip.label}</span>
          ))}
          {a?.blockedReason && <span className="blocked" title={a.blockedReason}>won\u2019t convert</span>}
        </td>
        <td className="num">{duration(entry.probe?.durationSec ?? null)}</td>
        <td className="num">{bytes(entry.size)}</td>
        <td className="num">{work ? bytes(after) : "—"}</td>
        <td className="num save">{work && saving ? bytes(saving) : "—"}</td>
      </tr>
      {expanded && entry.probe && (
        <tr className="detail">
          <td />
          <td colSpan={6}>
            <TrackPanel
              entry={entry}
              blockedReason={a?.blockedReason}
              selection={selection ?? keepEverything(entry.probe)}
              onChange={onSelectionChange}
              selectedCount={selectedCount}
              isSelected={checked}
              onApplyToSelection={onApplyTracks}
              onConvert={onConvert}
              busy={busy}
              canConvert={Boolean(a && (a.videoWork || a.audioWork || selection) && !a.blockedReason)}
            />
          </td>
        </tr>
      )}
    </>
  );
}
