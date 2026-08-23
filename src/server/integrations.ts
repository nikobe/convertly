/**
 * Telling Radarr, Sonarr and Plex that a file changed underneath them.
 *
 * All of this is best-effort and must never fail a job: by the time it runs,
 * the swap has already happened and the library is correct on disk. A server
 * being down is a stale database, not a lost file.
 */

export interface ServiceConfig {
  url: string;
  apiKey: string;
}

export interface PlexConfig {
  url: string;
  /** Plex calls this a token; stored under the same field for one code path. */
  apiKey: string;
}

export interface IntegrationsConfig {
  radarr: ServiceConfig | null;
  sonarr: ServiceConfig | null;
  plex: PlexConfig | null;
}

export interface NotifyOutcome {
  service: "radarr" | "sonarr" | "plex";
  ok: boolean;
  detail: string;
}

/** Item with a library folder, as Radarr and Sonarr both report. */
export interface PathedItem {
  id: number;
  path: string;
  title?: string;
}

/**
 * Which library item owns this file.
 *
 * Matched on the folder path rather than the filename, because the filename
 * is precisely what we keep identical and it tells us nothing about which
 * item it belongs to. Longest match wins, so a nested folder beats its
 * parent.
 */
export function matchByPath<T extends PathedItem>(items: T[], filePath: string): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!item.path) continue;
    const folder = item.path.endsWith("/") ? item.path : `${item.path}/`;
    if (!filePath.startsWith(folder)) continue;
    if (!best || item.path.length > best.path.length) best = item;
  }
  return best;
}

/** Trim a trailing slash so joined paths never double up. */
export function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export class Integrations {
  private config: IntegrationsConfig;
  private timeoutMs: number;

  constructor(config: IntegrationsConfig, timeoutMs = 15_000) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  get anyConfigured(): boolean {
    return Boolean(this.config.radarr || this.config.sonarr || this.config.plex);
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  // ── health ───────────────────────────────────────────────────────────

  /** One reachability probe per configured service. Never throws. */
  async check(): Promise<NotifyOutcome[]> {
    const results: NotifyOutcome[] = [];

    for (const [service, cfg] of [["radarr", this.config.radarr], ["sonarr", this.config.sonarr]] as const) {
      if (!cfg) continue;
      try {
        const status = await this.json<{ version?: string }>(
          `${baseUrl(cfg.url)}/api/v3/system/status`,
          { headers: { "X-Api-Key": cfg.apiKey } },
        );
        results.push({ service, ok: true, detail: `v${status?.version ?? "?"}` });
      } catch (err) {
        results.push({ service, ok: false, detail: describe(err) });
      }
    }

    if (this.config.plex) {
      try {
        const sections = await this.plexSections();
        results.push({ service: "plex", ok: true, detail: `${sections.length} librar${sections.length === 1 ? "y" : "ies"}` });
      } catch (err) {
        results.push({ service: "plex", ok: false, detail: describe(err) });
      }
    }

    return results;
  }

  // ── after a swap ─────────────────────────────────────────────────────

  /**
   * Rescan whichever library owns this path.
   *
   * Sonarr and Radarr only re-read mediainfo when a filename changes, and we
   * deliberately keep it identical — so without this their databases go on
   * describing the file they imported rather than the one on disk.
   */
  async afterReplace(filePath: string): Promise<NotifyOutcome[]> {
    const outcomes: NotifyOutcome[] = [];
    const settled = await Promise.allSettled([
      this.rescanRadarr(filePath),
      this.rescanSonarr(filePath),
      this.refreshPlex(filePath),
    ]);
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) outcomes.push(result.value);
    }
    return outcomes;
  }

  private async rescanRadarr(filePath: string): Promise<NotifyOutcome | null> {
    const cfg = this.config.radarr;
    if (!cfg) return null;
    try {
      const movies = await this.json<PathedItem[]>(`${baseUrl(cfg.url)}/api/v3/movie`, {
        headers: { "X-Api-Key": cfg.apiKey },
      });
      const movie = matchByPath(movies ?? [], filePath);
      if (!movie) return { service: "radarr", ok: true, detail: "not a Radarr path" };

      // Disk-only. Never RenameMovie: a naming scheme containing
      // {MediaInfo VideoCodec} would rewrite the filename to say h265 and
      // re-score the item, which is the whole thing we are avoiding.
      await this.json(`${baseUrl(cfg.url)}/api/v3/command`, {
        method: "POST",
        headers: { "X-Api-Key": cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ name: "RescanMovie", movieId: movie.id }),
      });
      return { service: "radarr", ok: true, detail: `rescanned ${movie.title ?? movie.id}` };
    } catch (err) {
      return { service: "radarr", ok: false, detail: describe(err) };
    }
  }

  private async rescanSonarr(filePath: string): Promise<NotifyOutcome | null> {
    const cfg = this.config.sonarr;
    if (!cfg) return null;
    try {
      const series = await this.json<PathedItem[]>(`${baseUrl(cfg.url)}/api/v3/series`, {
        headers: { "X-Api-Key": cfg.apiKey },
      });
      const show = matchByPath(series ?? [], filePath);
      if (!show) return { service: "sonarr", ok: true, detail: "not a Sonarr path" };

      await this.json(`${baseUrl(cfg.url)}/api/v3/command`, {
        method: "POST",
        headers: { "X-Api-Key": cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ name: "RescanSeries", seriesId: show.id }),
      });
      return { service: "sonarr", ok: true, detail: `rescanned ${show.title ?? show.id}` };
    } catch (err) {
      return { service: "sonarr", ok: false, detail: describe(err) };
    }
  }

  private async plexSections(): Promise<{ id: string; path: string; title: string }[]> {
    const cfg = this.config.plex;
    if (!cfg) return [];
    const body = await this.json<{
      MediaContainer?: { Directory?: { key: string; title: string; Location?: { path: string }[] }[] };
    }>(`${baseUrl(cfg.url)}/library/sections`, {
      headers: { "X-Plex-Token": cfg.apiKey, accept: "application/json" },
    });
    const out: { id: string; path: string; title: string }[] = [];
    for (const directory of body?.MediaContainer?.Directory ?? []) {
      for (const location of directory.Location ?? []) {
        out.push({ id: directory.key, path: location.path, title: directory.title });
      }
    }
    return out;
  }

  /**
   * Refresh just the folder the file sits in.
   *
   * Plex's periodic scan looks for added and removed files, and analysis —
   * which is what records codec and bitrate — runs when an item is added. We
   * keep the path and the mtime identical, so nothing prompts a re-analysis
   * and Plex goes on believing the old codec. That matters because it decides
   * direct play against transcode from exactly that stored information.
   */
  private async refreshPlex(filePath: string): Promise<NotifyOutcome | null> {
    const cfg = this.config.plex;
    if (!cfg) return null;
    try {
      const sections = await this.plexSections();
      const section = matchByPath(
        sections.map((s, i) => ({ id: i, path: s.path, title: s.title, key: s.id })),
        filePath,
      );
      if (!section) return { service: "plex", ok: true, detail: "not in a Plex library" };

      const folder = filePath.slice(0, filePath.lastIndexOf("/"));
      const url =
        `${baseUrl(cfg.url)}/library/sections/${section.key}/refresh` +
        `?path=${encodeURIComponent(folder)}`;
      await fetch(url, {
        headers: { "X-Plex-Token": cfg.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { service: "plex", ok: true, detail: `refreshed ${section.title}` };
    } catch (err) {
      return { service: "plex", ok: false, detail: describe(err) };
    }
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("timed out") || message.includes("TimeoutError")) return "timed out";
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) return "not reachable";
  return message.slice(0, 120);
}
