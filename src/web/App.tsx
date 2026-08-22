import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrowseResponse, Bookmark, HealthReport, Root, DirEntry } from "../shared/types.ts";
import { api } from "./api.ts";
import { bytes, duration } from "./format.ts";

export function App() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [roots, setRoots] = useState<Root[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [listing, setListing] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const go = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.browse(path));
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.roots().then(setRoots).catch(() => setRoots([]));
    api.bookmarks().then(setBookmarks).catch(() => setBookmarks([]));
    void go();
  }, [go]);

  const videos = useMemo(() => listing?.entries.filter((e) => e.kind === "video") ?? [], [listing]);
  const actionable = useMemo(
    () => videos.filter((e) => e.assessment && (e.assessment.videoWork || e.assessment.audioWork) && !e.assessment.blockedReason),
    [videos],
  );
  const recoverable = useMemo(
    () => videos.filter((e) => selected.has(e.path)).reduce((sum, e) => sum + (e.assessment?.savingBytes ?? 0), 0),
    [videos, selected],
  );

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const selectAllActionable = () => setSelected(new Set(actionable.map((e) => e.path)));

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

  return (
    <div className="app">
      <Hud health={health} />

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
            {!loading && !error && listing && <Listing listing={listing} selected={selected} onToggle={toggle} onOpen={go} />}
          </div>
        </main>
      </div>

      <footer className="foot">
        <span>
          {videos.length} file{videos.length === 1 ? "" : "s"} · {actionable.length} worth converting
        </span>
        {actionable.length > 0 && (
          <button className="link" style={{ color: "var(--amber-dim)" }} onClick={selectAllActionable}>
            select all
          </button>
        )}
        <span className="spacer" />
        <span>
          {selected.size} selected · <span className="total">{bytes(recoverable)} recoverable</span>
        </span>
        <button className="cta" disabled title="Queueing arrives in phase 02. Phase 01 cannot modify any file.">
          Add to queue — phase 02
        </button>
      </footer>
    </div>
  );
}

function Hud({ health }: { health: HealthReport | null }) {
  return (
    <header className="hud">
      <span className="brand">Convertly</span>
      <span className="health">
        {health?.checks.map((check) => (
          <span className="hcheck" key={check.id} title={check.detail}>
            <span className={`dot${check.ok ? "" : " bad"}`} />
            {check.label}
          </span>
        ))}
      </span>
      <span className="spacer" />
      <span>read-only · phase 01</span>
    </header>
  );
}

function Listing({
  listing, selected, onToggle, onOpen,
}: {
  listing: BrowseResponse;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
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
          <th aria-label="Selected" />
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
            onToggle={() => onToggle(entry.path)}
            onOpen={() => onOpen(entry.path)}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  entry, checked, onToggle, onOpen,
}: {
  entry: DirEntry;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  if (entry.kind === "dir") {
    return (
      <tr className="clickable">
        <td className="pick" />
        <td className="name" colSpan={6}>
          <button className="dir" onClick={onOpen}>▸ {entry.name}</button>
        </td>
      </tr>
    );
  }

  if (entry.kind === "other") {
    return (
      <tr className="idle">
        <td className="pick" />
        <td className="name">{entry.name}</td>
        <td colSpan={5} />
      </tr>
    );
  }

  const a = entry.assessment;
  const work = Boolean(a && (a.videoWork || a.audioWork) && !a.blockedReason);

  return (
    <tr className={`${work ? "clickable" : "idle"}${checked ? " sel" : ""}`}>
      <td className="pick">
        {work && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select ${entry.name}`}
            style={{ accentColor: "var(--amber)" }}
          />
        )}
      </td>
      <td className="name" title={entry.name}>{entry.name}</td>
      <td className="chips">
        {a?.chips.map((chip) => (
          <span className={`chip ${chip.tone}`} key={chip.label} title={chip.title}>{chip.label}</span>
        ))}
        {a?.blockedReason && <span className="blocked" title={a.blockedReason}>· held</span>}
      </td>
      <td className="num">{duration(entry.probe?.durationSec ?? null)}</td>
      <td className="num">{bytes(entry.size)}</td>
      <td className="num">{work ? bytes(a?.estimatedBytes ?? null) : "—"}</td>
      <td className="num save">{work && a?.savingBytes ? bytes(a.savingBytes) : "—"}</td>
    </tr>
  );
}
