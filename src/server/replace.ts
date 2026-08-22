import { statSync, renameSync, mkdirSync, utimesSync, chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { resolveWithinRoots } from "./paths.ts";
import type { Root } from "../shared/types.ts";

/** Originals wait here, on the same volume, until the window expires. */
export const QUARANTINE_DIRNAME = ".convertly-quarantine";
export const DEFAULT_RETENTION_DAYS = 14;

export class ReplaceError extends Error {}

export interface ReplaceRecord {
  /** The path the media lives at — unchanged, byte-identical, before and after. */
  livePath: string;
  /** Where the original now sits. */
  quarantinePath: string;
  originalSize: number;
  newSize: number;
  originalMtimeMs: number;
  replacedAt: number;
}

/**
 * Swap an encoded file in for its original.
 *
 * The filename and extension are byte-identical afterwards, and the original
 * mtime and mode are restored onto the new file. That is what stops Radarr
 * and Sonarr re-scoring the item: after import they read quality and custom
 * formats from the filename, not from the file's contents.
 *
 * Both files must be on the same volume so the swap is a rename rather than a
 * copy — a copy is neither atomic nor affordable on a 40 GB file.
 */
export function replaceInPlace(sourcePath: string, tempPath: string, roots: Root[]): ReplaceRecord {
  const source = resolveWithinRoots(sourcePath, roots);
  const temp = resolveWithinRoots(tempPath, roots);

  if (!existsSync(source.path)) throw new ReplaceError(`Original has gone missing: ${source.path}`);
  if (!existsSync(temp.path)) throw new ReplaceError(`Encoded file is not there: ${temp.path}`);

  const sourceStat = statSync(source.path);
  const tempStat = statSync(temp.path);

  if (sourceStat.dev !== tempStat.dev) {
    throw new ReplaceError(
      "The encoded file is on a different volume from the original, so the swap would be a copy rather than an atomic rename. " +
        "Encode into .convertly-tmp/ on the same drive.",
    );
  }
  if (tempStat.size === 0) throw new ReplaceError("Encoded file is empty.");

  const quarantineDir = join(dirname(source.path), QUARANTINE_DIRNAME);
  mkdirSync(quarantineDir, { recursive: true });

  // Timestamped so re-converting the same title twice cannot collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(quarantineDir, `${stamp}__${basename(source.path)}`);

  renameSync(source.path, quarantinePath);
  try {
    renameSync(temp.path, source.path);
  } catch (err) {
    // Put the original back rather than leaving the library with a hole.
    renameSync(quarantinePath, source.path);
    throw new ReplaceError(`Could not move the encoded file into place, original restored: ${(err as Error).message}`);
  }

  // Restore identity: same name, same mtime, same mode. Nothing downstream
  // should be able to tell the file was touched except by reading it.
  try {
    utimesSync(source.path, sourceStat.atime, sourceStat.mtime);
    chmodSync(source.path, sourceStat.mode & 0o7777);
  } catch {
    // Not fatal — the swap succeeded and the name is what matters.
  }

  return {
    livePath: source.path,
    quarantinePath,
    originalSize: sourceStat.size,
    newSize: tempStat.size,
    originalMtimeMs: sourceStat.mtimeMs,
    replacedAt: Date.now(),
  };
}

/**
 * Undo a replace: the original goes back to its path and the converted file
 * takes its place in quarantine, so an undo is itself undoable.
 */
export function restore(record: ReplaceRecord, roots: Root[]): void {
  const live = resolveWithinRoots(record.livePath, roots);
  const quarantined = resolveWithinRoots(record.quarantinePath, roots);

  if (!existsSync(quarantined.path)) {
    throw new ReplaceError(`The original is no longer in quarantine: ${quarantined.path}`);
  }

  const parked = `${quarantined.path}.replaced`;
  if (existsSync(live.path)) renameSync(live.path, parked);
  try {
    renameSync(quarantined.path, live.path);
  } catch (err) {
    if (existsSync(parked)) renameSync(parked, live.path);
    throw new ReplaceError(`Could not restore the original: ${(err as Error).message}`);
  }
  try {
    utimesSync(live.path, new Date(record.originalMtimeMs), new Date(record.originalMtimeMs));
  } catch {
    /* best effort */
  }
}

export interface SweepResult {
  removed: string[];
  freedBytes: number;
  kept: number;
}

/**
 * Delete quarantined originals past the retention window.
 *
 * Deliberately conservative: it only ever looks inside directories named
 * `.convertly-quarantine` under a configured root, and only at files older
 * than the window.
 */
export function sweepQuarantine(
  roots: Root[],
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = Date.now(),
): SweepResult {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  let freedBytes = 0;
  let kept = 0;

  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const dir of findQuarantineDirs(root.path)) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        // Age from when it was quarantined, not the preserved original mtime.
        if (stat.ctimeMs > cutoff) {
          kept++;
          continue;
        }
        try {
          rmSync(path);
          removed.push(path);
          freedBytes += stat.size;
        } catch {
          kept++;
        }
      }
    }
  }
  return { removed, freedBytes, kept };
}

function findQuarantineDirs(root: string, depth = 0): string[] {
  if (depth > 6) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === QUARANTINE_DIRNAME) {
      found.push(join(root, entry.name));
      continue;
    }
    if (entry.name.startsWith(".")) continue;
    found.push(...findQuarantineDirs(join(root, entry.name), depth + 1));
  }
  return found;
}
