import type { BrowseResponse, Bookmark, HealthReport, Root } from "../shared/types.ts";
import type { QueueSnapshot } from "../shared/queue.ts";
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

  presets: () => get<{ presets: Preset[]; active: Preset; builtIn: Preset }>("/api/presets"),

  async saveDefaultPreset(preset: Preset): Promise<Preset> {
    const res = await fetch("/api/presets/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preset),
    });
    const body = (await res.json()) as Preset & { error?: string };
    if (!res.ok) throw new Error(body.error ?? "Could not save that preset.");
    return body;
  },

  queue: () => get<QueueSnapshot>("/api/queue"),

  async addToQueue(
    items: { path: string; selection: Selection }[],
    preset: Partial<Preset>,
  ): Promise<{ added: number; skipped: { path: string; reason: string }[] }> {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, preset }),
    });
    const body = (await res.json()) as { added: number; skipped: { path: string; reason: string }[]; error?: string };
    if (!res.ok) throw new Error(body.error ?? "Could not add those to the queue.");
    return body;
  },

  async queueAction(action: "pause" | "resume" | "clear"): Promise<void> {
    const res = await fetch(`/api/queue/${action}`, { method: "POST" });
    if (!res.ok) throw new Error(`Could not ${action} the queue.`);
  },

  async acceptAll(): Promise<{ accepted: number; skipped: { name: string; reason: string }[] }> {
    const res = await fetch("/api/queue/accept-all", { method: "POST" });
    if (!res.ok) throw new Error("Could not accept those.");
    return res.json() as Promise<{ accepted: number; skipped: { name: string; reason: string }[] }>;
  },

  async queueItemAction(id: string, action: "accept" | "discard" | "retry"): Promise<void> {
    const res = await fetch(`/api/queue/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not ${action} that item.`);
    }
  },

  async removeFromQueue(id: string): Promise<void> {
    const res = await fetch(`/api/queue/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not remove that item.");
  },

  async removeBookmark(id: number): Promise<void> {
    const res = await fetch(`/api/bookmarks/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not remove that bookmark.");
  },
};
