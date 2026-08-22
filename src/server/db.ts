import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Probe, Bookmark } from "../shared/types.ts";

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "convertly.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS probes (
        path      TEXT PRIMARY KEY,
        size      INTEGER NOT NULL,
        mtime_ms  REAL    NOT NULL,
        probed_at INTEGER NOT NULL,
        json      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS probes_probed_at ON probes(probed_at);

      CREATE TABLE IF NOT EXISTS bookmarks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        label      TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        root_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Cached probe for a file, but only if size and mtime still match — an
   * edited file must be re-probed, and this is what makes a rescan of an
   * unchanged library nearly free.
   */
  getProbe(path: string, size: number, mtimeMs: number): Probe | null {
    const row = this.db
      .prepare("SELECT json, size, mtime_ms FROM probes WHERE path = ?")
      .get(path) as { json: string; size: number; mtime_ms: number } | undefined;
    if (!row) return null;
    if (row.size !== size) return null;
    // mtime comes back as a float; compare with a millisecond tolerance
    // rather than exactly, since filesystems vary in what they preserve.
    if (Math.abs(row.mtime_ms - mtimeMs) > 1) return null;
    try {
      return JSON.parse(row.json) as Probe;
    } catch {
      return null;
    }
  }

  putProbe(probe: Probe): void {
    this.db
      .prepare(
        `INSERT INTO probes (path, size, mtime_ms, probed_at, json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size, mtime_ms = excluded.mtime_ms,
           probed_at = excluded.probed_at, json = excluded.json`,
      )
      .run(probe.path, probe.size, probe.mtimeMs, probe.probedAt, JSON.stringify(probe));
  }

  countProbes(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM probes").get() as { n: number };
    return row.n;
  }

  listBookmarks(): Bookmark[] {
    const rows = this.db
      .prepare("SELECT id, label, path, root_id, created_at FROM bookmarks ORDER BY label COLLATE NOCASE")
      .all() as { id: number; label: string; path: string; root_id: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, label: r.label, path: r.path, rootId: r.root_id, createdAt: r.created_at }));
  }

  addBookmark(label: string, path: string, rootId: string): Bookmark {
    this.db
      .prepare(
        `INSERT INTO bookmarks (label, path, root_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET label = excluded.label`,
      )
      .run(label, path, rootId, Date.now());
    const row = this.db
      .prepare("SELECT id, label, path, root_id, created_at FROM bookmarks WHERE path = ?")
      .get(path) as { id: number; label: string; path: string; root_id: string; created_at: number };
    return { id: row.id, label: row.label, path: row.path, rootId: row.root_id, createdAt: row.created_at };
  }

  removeBookmark(id: number): boolean {
    const result = this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
