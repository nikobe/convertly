import type { BrowseResponse, Bookmark, HealthReport, Root } from "../shared/types.ts";

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

  async removeBookmark(id: number): Promise<void> {
    const res = await fetch(`/api/bookmarks/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not remove that bookmark.");
  },
};
