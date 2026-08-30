import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * An OS-managed lock, separate from the application database. Holding a
 * rollback-mode SQLite transaction keeps a second process out even when it
 * chooses another HTTP port. A crash releases the lock automatically; PID
 * files and stale-lock deletion cannot safely provide that guarantee.
 * Never unlink this file: existing owners must keep locking the same inode.
 */
export function acquireInstance(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lock = new DatabaseSync(join(dataDir, "instance.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    // Materialise the database while retaining the exclusive transaction.
    lock.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)");
  } catch (err) {
    lock.close();
    if ((err as { errcode?: number }).errcode === 5) {
      throw new Error(`Convertly is already using ${dataDir}. Stop that instance before starting another.`);
    }
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.close();
  };
}
