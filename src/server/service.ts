import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import type { QueueSnapshot } from "../shared/queue.ts";

const run = promisify(execFile);
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

interface Identity {
  app: string;
  pid: number;
  instanceId?: string;
  cwd: string;
  dataDir: string;
  configPath: string;
  port: number;
  logPath?: string | null;
  legacy?: boolean;
}

/** Local process control only: never use a PID file as authority to kill. */
export async function service(command: string, force = false): Promise<void> {
  if (!["status", "start", "stop", "restart"].includes(command)) {
    throw new Error("Usage: service.ts status|start|stop|restart [--force]");
  }
  if (force && command !== "stop" && command !== "restart") throw new Error("--force is only valid for stop or restart.");
  const configPath = resolve(process.env.CONVERTLY_CONFIG ?? "config/convertly.json");
  const config = loadConfig(configPath);
  const cwd = canonical(process.cwd());
  const dataDir = canonical(config.dataDir);
  const logPath = join(dataDir, "server.log");
  const metadataPath = join(dataDir, "service.json");
  const hostname = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const port = () => {
    if (config.port) return config.port;
    try { return (JSON.parse(readFileSync(metadataPath, "utf8")) as Identity).port; } catch { return null; }
  };
  const base = () => { const n = port(); return n ? `http://${host}:${n}` : null; };
  const request = async (path: string, method = "GET") => {
    const url = base();
    if (!url) throw new Error("No running service address.");
    return fetch(url + path, { method, signal: AbortSignal.timeout(5000) });
  };
  const json = async <T>(path: string, method = "GET"): Promise<T> => {
    const response = await request(path, method);
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}; no process was signalled.`);
    return await response.json() as T;
  };

  // Compatibility with the pre-service-control deployment. Require the exact
  // entrypoint, working directory AND open database; a random Node listener
  // (or another checkout) is not ours to manage.
  const legacy = async (expectedPid?: number): Promise<Identity> => {
    const { stdout } = await run("lsof", ["-nP", ...(expectedPid ? ["-a", "-p", String(expectedPid)] : []),
      `-iTCP:${port()}`, "-sTCP:LISTEN", "-Fp"], { timeout: 15000 });
    const pids = [...new Set(stdout.split("\n").filter((s) => s.startsWith("p")).map((s) => Number(s.slice(1))))];
    if (pids.length !== 1 || !pids[0]) throw new Error("Cannot identify a single Convertly listener.");
    const pid = pids[0];
    const [{ stdout: commandLine }, { stdout: directory }, { stdout: files }] = await Promise.all([
      run("ps", ["-p", String(pid), "-o", "command="], { timeout: 5000 }),
      run("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5000 }),
      run("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], { timeout: 5000 }),
    ]);
    const entry = join(cwd, "src/server/index.ts");
    const executable = commandLine.trim().match(/^(?:\S*\/)?node (.+)$/)?.[1];
    const processDir = directory.split("\n").find((s) => s.startsWith("n"))?.slice(1);
    const openFiles = files.split("\n").filter((s) => s.startsWith("n")).map((s) => s.slice(1));
    if (!processDir || canonical(processDir) !== cwd ||
      (executable !== "src/server/index.ts" && executable !== entry) ||
      !openFiles.some((path) => canonical(path) === join(dataDir, "convertly.db"))) {
      throw new Error("The listener is not the Convertly process for this checkout and database; refusing to manage it.");
    }
    return { app: "convertly", pid, cwd, dataDir, configPath, port: port()!, legacy: true };
  };
  const inspect = async (): Promise<Identity | null> => {
    if (!base()) return null;
    let response;
    try { response = await request("/api/service"); } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
      throw new Error(`Cannot reach ${base()}; refusing to assume the service is stopped.`, { cause: err });
    }
    if (response.status === 404) return legacy();
    if (!response.ok) throw new Error(`Service is unavailable (HTTP ${response.status}); try again after startup/shutdown completes.`);
    const owner = await response.json() as Identity;
    if (owner.app !== "convertly" || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !owner.instanceId ||
      canonical(owner.cwd) !== cwd || canonical(owner.dataDir) !== dataDir || canonical(owner.configPath) !== canonical(configPath)) {
      throw new Error("The listening service belongs to a different checkout/configuration; refusing to manage it.");
    }
    const processOwner = await legacy(owner.pid);
    if (processOwner.pid !== owner.pid) throw new Error("The service identity does not match the OS listener; refusing to manage it.");
    return owner;
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw err;
    }
  };
  const stop = async () => {
    const owner = await inspect();
    if (!owner) { console.log("Convertly is already stopped."); return; }
    const before = await json<QueueSnapshot>("/api/queue");
    if (!force && before.items.some((i) => i.state === "running")) {
      throw new Error("An encode or verification is running. Pause the queue and let it finish, then retry. --force discards its progress.");
    }
    // Pause before the final check so queued work cannot start between check
    // and signal. New servers persist this pause across the restart.
    const paused = await json<QueueSnapshot>("/api/queue/pause", "POST");
    if (!force && paused.items.some((i) => i.state === "running")) {
      throw new Error("A job started during the stop request. The queue is now paused; let the job finish and retry.");
    }
    const current = await inspect();
    if (!current || current.pid !== owner.pid || current.instanceId !== owner.instanceId) {
      throw new Error("Service ownership changed during the stop request; nothing was signalled.");
    }
    process.kill(owner.pid, "SIGTERM");
    const deadline = Date.now() + 10000;
    while (alive(owner.pid) && Date.now() < deadline) await delay(100);
    if (alive(owner.pid)) throw new Error(`PID ${owner.pid} has not exited. No force-kill or replacement launch was attempted.`);
    console.log(`Stopped Convertly (PID ${owner.pid}). The queue remains paused on servers that support persistent pause.`);
  };
  const start = async () => {
    const owner = await inspect();
    if (owner) { console.log(`Convertly is already running (PID ${owner.pid}) at ${base()}.`); return; }
    mkdirSync(dataDir, { recursive: true });
    const log = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, [join(cwd, "src/server/index.ts")], {
      cwd, env: { ...process.env, CONVERTLY_CONFIG: configPath, CONVERTLY_LOG_PATH: logPath,
        ...(command === "restart" ? {CONVERTLY_START_PAUSED: "1"} : {}) },
      detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    let spawnError: Error | undefined;
    child.on("error", (err) => { spawnError = err; });
    child.unref();
    const deadline = Date.now() + 20000;
    try {
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (!child.pid || !alive(child.pid)) throw new Error(`Startup failed. See ${logPath}.`);
        try {
          const running = await inspect();
          if (running?.pid === child.pid) {
            const health = await json<{ ok: boolean }>("/api/health");
            console.log(`Started Convertly (PID ${running.pid}) at ${base()}. Log: ${logPath}`);
            if (!health.ok) console.log("Health has warnings; check the app's health panel before converting.");
            return;
          }
          if (running) throw new Error("Another instance won the startup race.");
        } catch (err) {
          // Only a starting server's explicit 503 is a normal readiness wait.
          if (!(err as Error).message.includes("HTTP 503")) throw err;
        }
        await delay(100);
      }
      throw new Error(`Startup did not become ready. See ${logPath}.`);
    } catch (err) {
      if (child.pid && alive(child.pid)) child.kill("SIGTERM");
      throw err;
    }
  };

  if (command === "status") {
    const owner = await inspect();
    if (!owner) { console.log("Convertly is stopped."); return; }
    const q = await json<QueueSnapshot>("/api/queue");
    console.log(JSON.stringify({ status: "running", ...owner, url: base(),
      log: owner.logPath ?? "Manual/legacy launch: inspect its stdout with lsof; see docs/OPERATIONS.md.",
      queue: { paused: q.heldBy === "paused", states: q.items.reduce<Record<string, number>>((out, i) => {
        out[i.state] = (out[i.state] ?? 0) + 1; return out;
      }, {}) } }, null, 2));
  } else {
    if (command === "stop" || command === "restart") await stop();
    if (command === "start" || command === "restart") await start();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = "status", ...flags] = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--force")) {
    console.error("Unknown option. Usage: service.ts status|start|stop|restart [--force]");
    process.exitCode = 1;
  } else {
    service(command, flags.includes("--force")).catch((err: Error) => {
      console.error(err.message);
      process.exitCode = 1;
    });
  }
}
