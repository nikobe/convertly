/**
 * Which container the output goes in.
 *
 * The replace protocol keeps the filename byte-identical, which is what stops
 * Sonarr and Radarr re-scoring an item. That works when the source container
 * can carry the codec we produce — and for a great many libraries it cannot.
 * AVI has no usable HEVC support at all, so an AVI source forces a choice
 * between a mislabelled file and a changed name. A changed name is honest;
 * a Matroska file called .avi is not.
 */

/** Containers that can carry HEVC, and the ffmpeg format for each. */
const HEVC_CAPABLE: Record<string, { ext: string; needsHvc1: boolean }> = {
  ".mkv": { ext: ".mkv", needsHvc1: false },
  ".mp4": { ext: ".mp4", needsHvc1: true },
  ".m4v": { ext: ".m4v", needsHvc1: true },
  ".mov": { ext: ".mov", needsHvc1: true },
};

export interface ContainerPlan {
  /** Extension the output file will carry. */
  extension: string;
  /** True when that differs from the source, so the filename must change. */
  changed: boolean;
  /** Apple's players need the hvc1 tag to play HEVC in an MP4 family file. */
  needsHvc1: boolean;
  /** Said plainly, for the UI, when the name has to change. */
  reason: string | null;
}

export function planContainer(sourcePath: string): ContainerPlan {
  const dot = sourcePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : sourcePath.slice(dot).toLowerCase();
  const capable = HEVC_CAPABLE[ext];

  if (capable) {
    return { extension: capable.ext, changed: false, needsHvc1: capable.needsHvc1, reason: null };
  }
  return {
    extension: ".mkv",
    changed: true,
    needsHvc1: false,
    reason:
      `${ext || "this container"} cannot carry HEVC, so the file becomes .mkv. ` +
      `The name changes, which Sonarr and Radarr will notice on their next scan — ` +
      `the quality tokens in the name are unchanged, so it should re-import at the same quality.`,
  };
}

/** Filename with the extension swapped, keeping everything before it intact. */
export function withExtension(path: string, extension: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot === -1 || dot < slash) return path + extension;
  return path.slice(0, dot) + extension;
}
