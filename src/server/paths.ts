import { realpathSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import type { Root } from "../shared/types.ts";

export class PathNotAllowedError extends Error {
  constructor(requested: string) {
    super(`Path is outside every configured media root: ${requested}`);
    this.name = "PathNotAllowedError";
  }
}

/**
 * True when `candidate` is `root` itself or sits beneath it.
 *
 * Compares on a separator boundary so that /Volumes/Media/Movies does not
 * match /Volumes/Media/MoviesArchive, which a plain startsWith would.
 */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolve a client-supplied path to a canonical one inside a configured root,
 * or throw. This is the only way the server should ever turn a request into a
 * filesystem path.
 *
 * Symlinks are followed before the check, so a link inside a root that points
 * somewhere else on disk is rejected rather than followed out of the sandbox.
 * For a path that does not exist yet, the nearest existing ancestor is
 * canonicalised instead, which closes the same hole for new paths.
 */
export function resolveWithinRoots(requested: string, roots: Root[]): { path: string; root: Root } {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathNotAllowedError(String(requested));
  }
  // Reject NUL early — it can truncate a path inside a syscall.
  if (requested.includes("\0")) throw new PathNotAllowedError(requested);

  const absolute = resolve(requested);
  const canonical = canonicalise(absolute);

  for (const root of roots) {
    const canonicalRoot = canonicalise(root.path);
    if (isWithin(canonicalRoot, canonical)) return { path: canonical, root };
  }
  throw new PathNotAllowedError(requested);
}

/**
 * realpath the path, or if it does not exist, realpath the nearest ancestor
 * that does and re-attach the remainder.
 */
function canonicalise(absolute: string): string {
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const canonicalParent = canonicalise(parent);
    return resolve(canonicalParent, absolute.slice(parent.length + 1));
  }
}
