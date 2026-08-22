/** Types shared between the Fastify server and the browser client. */

/** A configured media root. Everything the app touches must live under one. */
export interface Root {
  id: string;
  label: string;
  path: string;
}

export type ChipTone = "bad" | "warn" | "note" | "good";

/** A codec or property badge shown against a file in the browser. */
export interface Chip {
  label: string;
  tone: ChipTone;
  /** Shown on hover — why this chip is here and what it means for you. */
  title: string;
}

export interface AudioTrack {
  index: number;
  codec: string;
  channels: number;
  channelLayout: string | null;
  language: string | null;
  title: string | null;
  bitrate: number | null;
  /** TrueHD/EAC3 streams carrying Atmos objects. Excluded from replace by default. */
  hasAtmos: boolean;
  /** The track the muxer marks as default. */
  isDefault: boolean;
}

export interface VideoTrack {
  index: number;
  codec: string;
  width: number;
  height: number;
  pixFmt: string | null;
  bitDepth: number | null;
  fps: number | null;
  bitrate: number | null;
  /** HDR10, HDR10+, Dolby Vision, HLG — null when SDR. */
  hdr: string | null;
}

export interface SubtitleTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  forced: boolean;
}

/** The result of probing one media file, as cached in SQLite. */
export interface Probe {
  path: string;
  size: number;
  mtimeMs: number;
  durationSec: number | null;
  container: string | null;
  video: VideoTrack | null;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  chapters: number;
  probedAt: number;
  /** ffprobe reported a problem; the file is listed but not assessed. */
  error: string | null;
}

/** What the app thinks should happen to a file, and what it would save. */
export interface Assessment {
  /** Video needs re-encoding to HEVC. */
  videoWork: boolean;
  /** At least one audio track the target chain won't direct-play. */
  audioWork: boolean;
  /** Encoder the resolution split selects. */
  encoder: "libx265" | "hevc_videotoolbox" | null;
  /** Bits per pixel per frame — catches bloated files chips alone miss. */
  bitsPerPixel: number | null;
  estimatedBytes: number | null;
  savingBytes: number | null;
  chips: Chip[];
  /** Present when the file should be left alone; explains why. */
  blockedReason: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: "dir" | "video" | "other";
  size: number | null;
  mtimeMs: number | null;
  probe: Probe | null;
  assessment: Assessment | null;
}

export interface BrowseResponse {
  path: string;
  rootId: string;
  /** Breadcrumb segments from the root down to `path`. */
  trail: { label: string; path: string }[];
  parent: string | null;
  entries: DirEntry[];
  volume: { totalBytes: number; freeBytes: number } | null;
}

export interface Bookmark {
  id: number;
  label: string;
  path: string;
  rootId: string;
  createdAt: number;
}

export interface HealthReport {
  ok: boolean;
  checks: {
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }[];
}
