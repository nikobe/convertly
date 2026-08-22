import type { BrowseResponse, Bookmark, HealthReport, Root } from "../shared/types.ts";
import type { Job } from "../shared/job.ts";
import type { Selection } from "../shared/estimate.ts";
import type { Preset } from "../shared/preset.ts";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<HealthReport>("/api/health"),
  roots: () => get<Root[]>("/api/roots"),
  browse: (path?: string) => get<BrowseResponse>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  bookmarks: () => get<Bookmark[]>("/api/bookmarks"),

  async addBookmark(path: string, label: string): Promise<Bookmark> {
    const res = await fetch("/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, label }),
    });
    if (!res.ok) throw new Error("Could not save that bookmark.");
    return res.json() as Promise<Bookmark>;
  },

  async startJob(path: string, selection: Selection, preset: Partial<Preset>, replace: boolean): Promise<Job> {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, selection, preset, replace }),
    });
    const body = (await res.json()) as Job & { error?: string };
    if (!res.ok) throw new Error(body.error ?? "Could not start that job.");
    return body;
  },

  async jobAction(id: string, action: "accept" | "discard" | "cancel"): Promise<void> {
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not ${action} that job.`);
    }
  },

  async removeBookmark(id: number): Promise<void> {
    const res = await fetch(`/api/bookmarks/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not remove that bookmark.");
  },
};
