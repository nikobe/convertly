import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Probe, Bookmark, Conversion } from "../shared/types.ts";
import { DEFAULT_PRESET, type Preset } from "../shared/preset.ts";

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

      CREATE TABLE IF NOT EXISTS conversions (
        path            TEXT PRIMARY KEY,
        converted_at    INTEGER NOT NULL,
        original_size   INTEGER NOT NULL,
        new_size        INTEGER NOT NULL,
        encoder         TEXT NOT NULL,
        vmaf            REAL,
        ffmpeg_version  TEXT NOT NULL,
        quarantine_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS presets (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        json       TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
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

  /**
   * Record a completed conversion.
   *
   * Not bookkeeping for its own sake: without it the scanner sees our own
   * 10-bit HEVC output, notices a high bits-per-pixel on grainy material, and
   * cheerfully offers to convert it again.
   */
  recordConversion(row: Conversion): void {
    this.db
      .prepare(
        `INSERT INTO conversions
           (path, converted_at, original_size, new_size, encoder, vmaf, ffmpeg_version, quarantine_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           converted_at = excluded.converted_at, original_size = excluded.original_size,
           new_size = excluded.new_size, encoder = excluded.encoder, vmaf = excluded.vmaf,
           ffmpeg_version = excluded.ffmpeg_version, quarantine_path = excluded.quarantine_path`,
      )
      .run(row.path, row.convertedAt, row.originalSize, row.newSize, row.encoder, row.vmaf, row.ffmpegVersion, row.quarantinePath);
  }

  getConversion(path: string): Conversion | null {
    const row = this.db
      .prepare(`SELECT path, converted_at, original_size, new_size, encoder, vmaf, ffmpeg_version, quarantine_path
                FROM conversions WHERE path = ?`)
      .get(path) as Record<string, unknown> | undefined;
    return row ? toConversion(row) : null;
  }

  /** Conversions for a set of paths, for annotating one directory listing. */
  getConversions(paths: string[]): Map<string, Conversion> {
    const out = new Map<string, Conversion>();
    if (paths.length === 0) return out;
    const statement = this.db.prepare(
      `SELECT path, converted_at, original_size, new_size, encoder, vmaf, ffmpeg_version, quarantine_path
       FROM conversions WHERE path = ?`,
    );
    for (const path of paths) {
      const row = statement.get(path) as Record<string, unknown> | undefined;
      if (row) out.set(path, toConversion(row));
    }
    return out;
  }

  /** Running total of space recovered. */
  savings(): { files: number; bytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS files, COALESCE(SUM(original_size - new_size), 0) AS bytes FROM conversions")
      .get() as { files: number; bytes: number };
    return { files: row.files, bytes: row.bytes };
  }

  /** Forget a conversion — used when an original is restored. */
  forgetConversion(path: string): void {
    this.db.prepare("DELETE FROM conversions WHERE path = ?").run(path);
  }

  listPresets(): Preset[] {
    const rows = this.db
      .prepare("SELECT json FROM presets ORDER BY is_default DESC, name COLLATE NOCASE")
      .all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Preset);
  }

  /** The preset offered on the next encode. Falls back to the built-in. */
  defaultPreset(): Preset {
    const row = this.db.prepare("SELECT json FROM presets WHERE is_default = 1 LIMIT 1").get() as
      | { json: string }
      | undefined;
    if (!row) return DEFAULT_PRESET;
    try {
      return { ...DEFAULT_PRESET, ...(JSON.parse(row.json) as Preset) };
    } catch {
      return DEFAULT_PRESET;
    }
  }

  savePreset(preset: Preset, makeDefault: boolean): Preset {
    this.db
      .prepare(
        `INSERT INTO presets (id, name, json, is_default, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(preset.id, preset.name, JSON.stringify(preset), makeDefault ? 1 : 0, Date.now());
    if (makeDefault) {
      this.db.prepare("UPDATE presets SET is_default = 0 WHERE id != ?").run(preset.id);
      this.db.prepare("UPDATE presets SET is_default = 1 WHERE id = ?").run(preset.id);
    }
    return preset;
  }

  deletePreset(id: string): boolean {
    return this.db.prepare("DELETE FROM presets WHERE id = ?").run(id).changes > 0;
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

function toConversion(row: Record<string, unknown>): Conversion {
  return {
    path: row.path as string,
    convertedAt: row.converted_at as number,
    originalSize: row.original_size as number,
    newSize: row.new_size as number,
    encoder: row.encoder as string,
    vmaf: (row.vmaf as number | null) ?? null,
    ffmpegVersion: row.ffmpeg_version as string,
    quarantinePath: row.quarantine_path as string,
  };
}
