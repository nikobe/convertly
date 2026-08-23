import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByPath, baseUrl, Integrations } from "./integrations.ts";

test("a file is matched to the library item whose folder contains it", () => {
  const movies = [
    { id: 1, path: "/Volumes/Media-1/Movies/Some Film (1999)", title: "Some Film" },
    { id: 2, path: "/Volumes/Media-1/Movies/Other Film (2001)", title: "Other Film" },
  ];
  const hit = matchByPath(movies, "/Volumes/Media-1/Movies/Some Film (1999)/Some Film (1999).mkv");
  assert.equal(hit?.id, 1);
});

test("the longest matching folder wins", () => {
  // A collection folder nested inside a library root must not shadow the item.
  const items = [
    { id: 1, path: "/media/Movies" },
    { id: 2, path: "/media/Movies/Boxset/Part Two (2004)" },
  ];
  assert.equal(matchByPath(items, "/media/Movies/Boxset/Part Two (2004)/film.mkv")?.id, 2);
});

test("a folder name that is a prefix of another does not match", () => {
  // "/media/Movies" must not claim a file in "/media/MoviesArchive".
  const items = [{ id: 1, path: "/media/Movies" }];
  assert.equal(matchByPath(items, "/media/MoviesArchive/film.mkv"), null);
});

test("a file outside every library matches nothing", () => {
  const items = [{ id: 1, path: "/media/Movies" }];
  assert.equal(matchByPath(items, "/elsewhere/film.mkv"), null);
});

test("items with no path are ignored rather than throwing", () => {
  const items = [{ id: 1, path: "" }, { id: 2, path: "/media/TV" }];
  assert.equal(matchByPath(items, "/media/TV/Show/ep.mkv")?.id, 2);
});

test("base URLs are joined without doubling the slash", () => {
  assert.equal(baseUrl("http://localhost:7878/"), "http://localhost:7878");
  assert.equal(baseUrl("http://localhost:7878///"), "http://localhost:7878");
  assert.equal(baseUrl("  http://localhost:7878  "), "http://localhost:7878");
});

test("nothing configured means nothing to do", async () => {
  const none = new Integrations({ radarr: null, sonarr: null, plex: null });
  assert.equal(none.anyConfigured, false);
  assert.deepEqual(await none.check(), []);
  assert.deepEqual(await none.afterReplace("/media/Movies/x.mkv"), []);
});

test("an unreachable service reports rather than throwing", async () => {
  // The swap has already happened by this point: a server being down is a
  // stale database, never a failed job.
  const dead = new Integrations(
    { radarr: { url: "http://127.0.0.1:9", apiKey: "x" }, sonarr: null, plex: null },
    250,
  );
  const outcomes = await dead.afterReplace("/media/Movies/Some Film (1999)/x.mkv");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.service, "radarr");
  assert.equal(outcomes[0]!.ok, false);
  const checks = await dead.check();
  assert.equal(checks[0]!.ok, false);
});
