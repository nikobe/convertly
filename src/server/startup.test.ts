import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Store, type QueueRow } from "./db.ts";
import { DEFAULT_PRESET } from "../shared/preset.ts";
import { sweepTempDirs } from "./pipeline.ts";
import { Queue } from "./queue.ts";
import { Governors } from "./governors.ts";
import { Integrations } from "./integrations.ts";
import { DEFAULT_GOVERNORS } from "../shared/governors.ts";

const run = promisify(execFile);
const entry = fileURLToPath(new URL("index.ts", import.meta.url));
const control = fileURLToPath(new URL("service.ts", import.meta.url));
const source = fileURLToPath(new URL("../", import.meta.url));

function fixture() {
  const dir = mkdtempSync("/private/tmp/convertly-startup-");
  const media = join(dir, "media");
  const dataDir = join(dir, "data");
  mkdirSync(media);
  symlinkSync(source, join(dir, "src"));
  // Startup only needs binary discovery. No real media or encoders are used.
  const binary = join(dir, "fake-ffmpeg");
  writeFileSync(binary, "#!/bin/sh\nprintf 'ffmpeg version startup-test\\n'\n", { mode: 0o755 });
  const config = { host: "127.0.0.1", port: 0, dataDir, roots: [{id: "test", label: "Test", path: media}],
    allowedClients: ["127.0.0.1"], ffmpegPath: binary, ffprobePath: binary,
    governors: { thermal: {enabled: false}, playback: {enabled: false}, disk: {enabled: false} } };
  const configPath = join(dir, "config.json");
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  save();
  return { dir, media, dataDir, config, configPath, save };
}

function launch(f: ReturnType<typeof fixture>) {
  const child = spawn(process.execPath, [entry], {
    cwd: f.dir, env: { ...process.env, CONVERTLY_CONFIG: f.configPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const exited = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({code, signal}));
  });
  const ready = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const base = logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (base) return base;
      if (child.exitCode !== null || child.signalCode) throw new Error(logs);
      await delay(30);
    }
    throw new Error("Startup timed out: " + logs);
  };
  return { child, exited, ready, logs: () => logs };
}

async function stop(process: ReturnType<typeof launch>, signal: NodeJS.Signals = "SIGTERM") {
  if (process.child.exitCode === null && !process.child.signalCode) process.child.kill(signal);
  const result = await Promise.race([process.exited, delay(6000, null, {ref: false})]);
  if (!result) { process.child.kill("SIGKILL"); await process.exited; assert.fail("Shutdown timed out"); }
  return result;
}

function row(path: string, state = "review", pending: string | null = null): QueueRow {
  return {id: path, path, name: path, state, pending_path: pending, position: 0, source_bytes: 100,
    estimated_bytes: 50, saved_bytes: 50, message: "test", selection_json: '{"audio":[],"subtitles":[]}',
    preset_json: JSON.stringify(DEFAULT_PRESET), checks_json: "[]", added_at: 1, started_at: null, finished_at: null};
}

test("cleanup preserves pending output and sidecars but removes abandoned directories", () => {
  const f = fixture();
  try {
    const kept = join(f.media, "film", ".convertly-tmp");
    const abandoned = join(f.media, "other", ".convertly-tmp");
    mkdirSync(kept, {recursive: true}); mkdirSync(abandoned, {recursive: true});
    const output = join(kept, "review.mkv");
    writeFileSync(output, "keep"); writeFileSync(join(kept, "sidecar"), "keep too");
    writeFileSync(join(abandoned, "crashed.mkv"), "discard");
    const alias = join(f.dir, "alias"); symlinkSync(f.media, alias);
    assert.deepEqual(sweepTempDirs(f.config.roots, [join(alias, "film/.convertly-tmp/review.mkv")]), [abandoned]);
    assert.equal(readFileSync(output, "utf8"), "keep");
    assert.equal(existsSync(join(kept, "sidecar")), true);
    assert.equal(existsSync(abandoned), false);
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

for (const action of ["pause", "shutdown"] as const) {
  test(`${action} during a pending governor check cannot start another job`, async () => {
    const f = fixture();
    const store = new Store(f.dataDir);
    try {
      const path = join(f.media, "waiting.mkv");
      store.addToQueue(row(path, "queued"));
      const governors = new Governors({...DEFAULT_GOVERNORS, thermal: {...DEFAULT_GOVERNORS.thermal, enabled: false}}, null);
      const status = await governors.evaluate();
      let finish!: (value: typeof status) => void;
      governors.evaluate = () => new Promise((resolve) => { finish = resolve; });
      const queue = new Queue({store, governors, roots: f.config.roots,
        integrations: new Integrations({radarr: null, sonarr: null, plex: null}),
        ffmpegPath: f.config.ffmpegPath, ffprobePath: f.config.ffprobePath, ffmpegVersion: "test"});
      const draining = queue.drain();
      queue[action]();
      finish(status);
      await draining;
      assert.equal(store.getQueueItem(path)!.state, "queued");
      if (action === "pause") assert.equal(store.queuePaused(), true);
    } finally { store.close(); rmSync(f.dir, {recursive: true, force: true}); }
  });
}

test("restart preserves reviews and pause; duplicate launches cannot mutate the queue or media", {timeout: 30000}, async () => {
  const f = fixture();
  const children: ReturnType<typeof launch>[] = [];
  try {
    const pending = join(f.media, ".convertly-tmp", "review.mkv");
    mkdirSync(join(f.media, ".convertly-tmp")); writeFileSync(pending, "review output");
    const seed = new Store(f.dataDir);
    seed.setQueuePaused(true);
    seed.addToQueue(row(join(f.media, "original.mkv"), "review", pending));
    seed.close();
    const first = launch(f); children.push(first);
    const base = await first.ready();
    assert.equal(readFileSync(pending, "utf8"), "review output");
    const reader = (await fetch(base + "/api/queue/events")).body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"heldBy":"paused"/);

    // Add sentinels only after the first server's startup cleanup is over.
    const abandoned = join(f.media, "abandoned/.convertly-tmp/output.mkv");
    const expired = join(f.media, ".convertly-quarantine/2000-01-01T00-00-00-000Z__old.mkv");
    mkdirSync(join(f.media, "abandoned/.convertly-tmp"), {recursive: true});
    mkdirSync(join(f.media, ".convertly-quarantine"));
    writeFileSync(abandoned, "do not sweep during a duplicate launch"); writeFileSync(expired, "original");
    const concurrent = new Store(f.dataDir);
    const interrupted = join(f.media, "interrupted.mkv");
    concurrent.addToQueue(row(interrupted, "running"));
    const duplicate = launch(f); children.push(duplicate);
    const duplicateExit = await duplicate.exited;
    assert.equal(duplicateExit.code, 1, duplicate.logs());
    assert.match(duplicate.logs(), /already using/);
    assert.equal(concurrent.getQueueItem(interrupted)!.state, "running");
    assert.ok(existsSync(abandoned) && existsSync(expired));
    concurrent.close();

    // A different store using the occupied port must fail BEFORE Store exists.
    f.config.port = Number(new URL(base).port);
    f.config.dataDir = join(f.dir, "different-data"); f.save();
    const occupied = launch(f); children.push(occupied);
    assert.equal((await occupied.exited).code, 1);
    assert.match(occupied.logs(), /EADDRINUSE/);
    assert.equal(existsSync(join(f.config.dataDir, "convertly.db")), false);
    assert.ok(existsSync(abandoned) && existsSync(expired));
    f.config.dataDir = f.dataDir; f.config.port = 0; f.save();

    assert.equal((await stop(first)).code, 0, first.logs());
    await reader.cancel().catch(() => {});
    const restarted = launch(f); children.push(restarted);
    const nextBase = await restarted.ready();
    const q = await (await fetch(nextBase + "/api/queue")).json() as {heldBy: string; items: {state: string}[]};
    assert.equal(q.heldBy, "paused");
    assert.deepEqual(q.items.map((i) => i.state).sort(), ["queued", "review"]);
    assert.equal(readFileSync(pending, "utf8"), "review output");
    assert.equal(existsSync(abandoned), false);

    await stop(restarted, "SIGKILL");
    const recovered = launch(f); children.push(recovered);
    await recovered.ready(); // Kernel released the database lock after a crash.
    assert.equal(readFileSync(pending, "utf8"), "review output");
  } finally {
    for (const child of children) await stop(child);
    rmSync(f.dir, {recursive: true, force: true});
  }
});

test("service commands identify their own process, refuse busy stops, and persist pause across restart", {timeout: 60000}, async () => {
  const f = fixture();
  let pid: number | undefined;
  const cli = (command: string) => run(process.execPath, [control, command], {
    cwd: f.dir, env: {...process.env, CONVERTLY_CONFIG: f.configPath}, timeout: 30000,
  });
  const metadata = () => JSON.parse(readFileSync(join(f.dataDir, "service.json"), "utf8")) as {pid: number; port: number};
  try {
    assert.match((await cli("status")).stdout, /stopped/);
    assert.match((await cli("start")).stdout, /Started Convertly/);
    pid = metadata().pid;
    const status = JSON.parse((await cli("status")).stdout) as {pid: number};
    assert.equal(status.pid, pid);
    assert.match((await cli("start")).stdout, /already running/);
    assert.equal(metadata().pid, pid);
    const foreign = fixture();
    try {
      foreign.config.port = metadata().port; foreign.save();
      await assert.rejects(run(process.execPath, [control, "stop"], {
        cwd: foreign.dir, env: {...process.env, CONVERTLY_CONFIG: foreign.configPath}, timeout: 15000,
      }), /different checkout\/configuration/);
      assert.doesNotThrow(() => process.kill(pid!, 0));
      const current = await (await fetch(`http://127.0.0.1:${metadata().port}/api/queue`)).json() as {heldBy: string | null};
      assert.equal(current.heldBy, null, "foreign stop must not even pause this queue");
    } finally { rmSync(foreign.dir, {recursive: true, force: true}); }
    const store = new Store(f.dataDir);
    store.addToQueue(row(join(f.media, "busy.mkv"), "running"));
    await assert.rejects(cli("stop"), /encode or verification is running/);
    assert.doesNotThrow(() => process.kill(pid!, 0));
    store.removeQueueItem(join(f.media, "busy.mkv")); store.close();
    assert.match((await cli("restart")).stdout, /Started Convertly/);
    assert.notEqual(metadata().pid, pid); pid = metadata().pid;
    const q = await (await fetch(`http://127.0.0.1:${metadata().port}/api/queue`)).json() as {heldBy: string};
    assert.equal(q.heldBy, "paused");
    assert.match((await cli("stop")).stdout, /Stopped Convertly/);
    pid = undefined;
    assert.match((await cli("status")).stdout, /stopped/);
  } finally {
    if (existsSync(join(f.dataDir, "service.json"))) pid = metadata().pid;
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await delay(500);
    rmSync(f.dir, {recursive: true, force: true});
  }
});
