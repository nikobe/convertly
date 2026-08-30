# Convertly operations and handover

Inspected on **2026-08-30**. This is a dated inventory, not a live status page.
No production restart, deployment, or conversion was performed during handover.

## Restart-safety update

Implemented on branch `codex/restart-safety` after the initial handover and
**activated on the Mac mini on 2026-08-30 at 11:57 BST**, at the user's request.
The server is running the tested, uncommitted working tree on that branch.
The historical inventory and legacy warnings below describe the original deployment.

Current rollout snapshot (recheck with `npm run service:status`):

- New listener: PID **16810**, direct detached Node process, parent PID 1.
  Previous listener 83565 and its npm parent 83553 have exited.
- Started with `CONVERTLY_START_PAUSED=1 npm run service:start`; logs append to
  `/Users/nikobe/Local/convertly/data/server.log`.
- Same URL: `http://100.107.73.115:8973/`, verified HTTP 200. Health passed,
  all seven media roots were readable, and queue event streaming worked.
- Queue remains paused, with the same one failed item and no active/queued
  encodes. Presets, queue records, conversion ledger, probe count, and bookmarks
  were checked against the pre-restart snapshot and preserved.
- Configuration and SQLite backup:
  `data/backups/restart-2026-08-30T10-57-25-017Z/`. Configuration bytes matched
  and the database backup passed `PRAGMA quick_check`.
- Startup reported clearing 10 unreferenced temporary directories; no
  quarantine removals were reported. No conversions were started.
- No Git commit/push, dependency install, UI rebuild, or launchd installation
  was performed for this restart. Reboot/login autostart remains unconfigured.

The new server reserves its HTTP socket before opening the application store
or sweeping media. While initializing, it returns 503 rather than serving
requests against incomplete state. It also holds an exclusive transaction in
`dataDir/instance.sqlite`, preventing two updated servers from sharing a store
even if they choose different ports. Exit/crash releases that lock automatically;
never remove its file while a server is running. Use local storage for `dataDir`.
Independent test instances must still have disjoint media roots.

Startup cleanup now preserves any scratch directory containing a queue item's
`pending_path`, including review outputs and sidecars. Unreferenced scratch
directories can still be swept. Pause is persisted; an in-flight governor check
cannot start another job after Pause or shutdown.

From the checkout, with Node 24+ selected:

```sh
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
```

- `status` is read-only and reports the process, URL, configuration, log, and
  queue states. It also recognizes the original detached `npm start` instance;
  that compatibility path was checked against the live PID without stopping it.
- `start` launches one detached Node process and waits for readiness. An
  already-running matching instance is left alone. Output appends to
  `dataDir/server.log`. A foreground/manual launch retains its existing stdout.
- `stop` checks for active work, pauses the queue, rechecks, verifies the
  listener's PID/entrypoint/working directory/open database, and sends SIGTERM
  only to that process. It waits for exit and never escalates to a broad kill.
- `restart` performs a stop and start, explicitly leaving the queue paused.
  Resume in the UI after checking health. `npm start` also honors a stored
  pause. `CONVERTLY_START_PAUSED=1` can force a hold during a controlled upgrade
  from the legacy version, which does not persist its pause.
- An active encode or verification prevents a normal stop/restart. Pause in
  the app, let it finish, and retry. `npm run service:restart -- --force` is the
  explicit option to lose the current job's progress; it still verifies the
  process and does not force-kill the server. Review outputs remain protected
  by the new startup sweep.

`CONVERTLY_CONFIG` selects the same config for these commands and the server.
They require local `lsof` and `ps`, and reject another checkout/configuration's
listener. This is process control, not a launchd installation: reboot/login
autostart has not been configured. Runtime metadata in `dataDir/service.json`
may remain after exit and is never trusted on its own for signalling a PID.

The revised `scripts/deploy.sh` requires clean `main` and a fast-forward from
`origin/main`. It checks divergence before downtime, uses the verified stop,
backs up configuration and SQLite under `dataDir/backups`, then updates,
validates, builds, and starts paused. It no longer uses broad `pkill` or kills
matching FFmpeg processes. A failure after stopping leaves an explicit error
and may leave the app stopped; there is no automatic rollback. This deployment
script has been syntax/guard checked, not executed against production.

Validation for this update: **160 tests passed, 0 failed, 6 pre-existing skips**;
server/web type checks and a build outside live `dist/web` passed. Regression
coverage exercises review persistence across restart, pause/shutdown races,
duplicate ports, shared-store exclusion, recovery after SIGKILL, shutdown with
an open event stream, service start/stop/restart, busy-stop refusal, and refusal
to control another checkout. It uses temporary roots/databases and simulated
binaries; it is not a full real-media pipeline test. The skipped fixture-based
pipeline tests and the later quality/container findings remain follow-up work.

## Original deployment at handover

| Item | Observed value |
| --- | --- |
| Host | `Niks-Mac-mini.local`, Intel macOS |
| Checkout / working directory | `/Users/nikobe/Local/convertly` |
| Repository | `https://github.com/nikobe/convertly.git` |
| Branch / revision | `main`, `1cea45c6f7544b6f1616d0b4892791fee6e2bcf8`; matched GitHub `main` |
| App | `http://100.107.73.115:8973/` and `http://127.0.0.1:8973/` |
| Listener | PID `83565`, `node src/server/index.ts` |
| Parent | PID `83553`, detached `npm start`, parent PID 1 |
| Started | 2026-08-26 23:28 BST |
| Node | `/Users/nikobe/.nvm/versions/node/v24.15.0/bin/node` |
| Current stdout/stderr | `/Users/nikobe/Local/convertly/logs/convertly.log` |
| Local config | `config/convertly.json` (ignored by Git) |
| Database | `data/convertly.db`, with WAL/SHM sidecars |
| FFmpeg / ffprobe | `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe`, version 9.0.1 |

The listener and its npm parent have stdin attached to `/dev/null` and output
attached to the log file. The original launching shell is gone. This explains
why closing a terminal, or pressing Ctrl-C in a new terminal, does not stop it.
The exact original launch command beyond `npm start` was not recovered.

No Convertly entry was found in the user's or system's launchd listings, the
standard LaunchAgents/LaunchDaemons directories, or the user's crontab. There
is no verified service manager or automatic restart arrangement. Tailscale
provides network access; it is not the process running the application.

`scripts/deploy.sh` uses a different launch method: direct `nohup node`, with
output at `data/server.log`. Do not assume that is the log for the current
instance. Rediscover the listener and open files after any deployment.

## State at handover

- Health returned `ok: true`; all seven configured media roots were readable.
- The ledger reported 172 converted files and 87,215,529,355 bytes saved
  (displayed as 81 GB). These are recorded savings, not an audit of recoverable
  quarantined originals or current free disk space.
- No jobs were queued or encoding. One failed `.m4v` job remained, reporting
  an FFmpeg `ipod` muxer error that no output packets were written. It was left
  untouched; the root cause has not been diagnosed.
- Active preset: CRF 22, medium, 10-bit, no downscale, automatic encoder
  selection, replacement audio up to 640,000 bit/s. The built-in CRF 20 is only
  a fallback; do not reset the stored preset during an upgrade.
- Time window and rhythm were disabled. Thermal and disk protection were
  enabled; thermal uses a minimum CPU speed limit of 70 and no level ceiling.
- Radarr, Sonarr, and Plex integrations were **not configured**. Automatic
  rescans and Plex playback detection therefore do not operate, even though
  playback protection is enabled in the defaults.
- Access was restricted to `127.0.0.1`, `::1`, and `100.64.0.0/10`, with the
  server listening on `0.0.0.0`. There is no application login.

## Inspect without interrupting it

Run these on the Mac mini:

```sh
lsof -nP -iTCP:8973 -sTCP:LISTEN
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8973/api/health
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8973/api/queue
```

For the PID currently returned by `lsof`, inspect its command and working
directory before sending signals. Do not reuse the historical PID blindly.

```sh
convertly_pid=$(lsof -t -nP -iTCP:8973 -sTCP:LISTEN)
ps -p "$convertly_pid" -o pid=,ppid=,lstart=,args=
lsof -nP -a -p "$convertly_pid" -d cwd,0,1,2
```

The queue snapshot's top-level `running: true` means the queue is enabled,
**not** that an encode is active. Inspect each item's `state` for `running`,
`queued`, and `review`. The UI's Pause action lets an active job finish but
prevents the next one starting. It does not stop the server, and the paused
flag does not survive a restart.

## Stop and start deliberately

Before a planned stop, pause if necessary and wait for the active encode and
verification to finish. Check for review items: the current startup sweep
deletes their encoded outputs. Do not accept or discard them automatically
just to enable a restart; preserve their output or fix that behavior first.
An urgent stop is possible, but an in-flight job loses its progress.

After verifying that `convertly_pid` still identifies this app's listener:

```sh
kill -TERM "$convertly_pid"
```

The server handles SIGTERM by aborting the encode, closing event streams, and
exiting, with a four-second forced-exit timer. Recheck `lsof` to confirm the
port is no longer listening. Avoid broad `pkill node`, and do not default to
SIGKILL: it skips shutdown and can orphan FFmpeg. If it remains alive, inspect
that specific process and its children before taking further action.

For an intentional foreground start, after confirming no instance is running:

```sh
cd /Users/nikobe/Local/convertly
nvm use
npm start
```

Keep that terminal open; Ctrl-C then reaches the foreground server. Check
`/api/health` after startup, including drive readability. macOS filesystem
permissions can differ depending on whether Terminal, SSH, or a service
manager launched Node.

Startup is not read-only: it migrates the database, sweeps scratch outputs and
expired quarantine, requeues interrupted jobs, and starts queued work. A clean
abort may record an item as cancelled; a row left `running` after a crash is
requeued. No interrupted encode resumes at its previous frame.

## Developing without touching production

Prefer a separate checkout/worktree for new versions. Its local config must
use a disposable media directory, a separate database, loopback-only access,
and a different port such as 18973. Do not copy production queue state into it.

`CONVERTLY_CONFIG` selects a config file. `dataDir` defaults to `data` relative
to the process working directory, and built assets are served from that
directory's `dist/web`. Use explicit absolute paths when testing outside the
checkout. Configuration has no general read-only mode.

In this live checkout, these validation commands avoid publishing new assets:

```sh
npm test
npm run typecheck
convertly_build_dir=$(mktemp -d /private/tmp/convertly-build.XXXXXX)
npm run build -- --outDir "$convertly_build_dir"
```

Do not run plain `npm run build` here just to check compilation: it immediately
replaces the assets being served. Do not run `npm run dev` against the default
config. For isolated UI development, change the dev checkout's Vite `/api`
proxy from 8973 to the isolated API port; starting only `dev:web` otherwise
connects the UI to production, including its preset autosave.

Before a release, validate in isolation, inspect/drain the live queue, protect
review outputs, stop the verified instance, and back up configuration and the
database. Use SQLite's backup mechanism for an online backup; copying only
`convertly.db` while WAL is active can omit committed state. Keep backups out
of Git. Install/build the reviewed revision, start one instance, and verify
health, queue state, and media-root access. A database backup does not back up
media or quarantine.

The existing deploy script checks for a running job, pulls `origin/main`,
builds, signals matching Node processes, and launches another one. Its guard
does not pause the queue or check review items; another job can start while
it builds. It also matches processes by command rather than checkout. Treat
it as legacy deployment tooling to harden before unattended use, not a status
or stop command. It was not run during handover.

## Validation baseline

- `npm test`: **155 passed, 0 failed, 6 skipped** (161 total).
- `npm run typecheck`: passed for server and web.
- Production build: passed in a unique `/private/tmp` directory and matched
  the live assets byte for byte. Live `dist/web` was not replaced.
- Live HTTP: the loopback and Tailscale URLs returned 200; health was green.
- Browser: the library and queue rendered; no captured warning/error console
  entries. No conversion controls or quality settings were changed. Loading
  the existing UI itself re-saves its current preset and can populate cache.
- Isolated service smoke check: passed using an empty temporary media root,
  a new database, and an automatically assigned loopback port. Verified health,
  browse, path rejection, built UI, and queue events. SIGTERM exited cleanly in
  315 ms with an event stream open. This did not exercise an active encoder.

The skipped tests in `src/server/pipeline.test.ts` require both a hardcoded
Apple Silicon Homebrew FFmpeg path and an ignored sample media fixture. Neither
was present here. The real-FFmpeg downmix checks did execute. The baseline is
not evidence that the complete encoding pipeline passed end to end on this
host, nor a full security or media-integrity audit.

## Follow-up work identified

These were identified during handover. Items 1 and the local-control portion
of 2 are implemented and live in the restart-safety update above.
The other findings remain open.

1. **Protect startup and review outputs.** `index.ts` runs `sweepTempDirs`
   before constructing the queue; `pipeline.ts` removes entire `.convertly-tmp`
   directories without consulting pending review items. The queue still points
   at the deleted files. Startup also performs these side effects before
   `app.listen`, so a second instance can interfere before its port conflict
   is detected. Add an instance guard and preserve referenced outputs.
2. **Make service ownership explicit.** Add reliable status/start/stop/restart
   control, consistent log placement, and a deliberate launchd arrangement if
   desired. Include graceful shutdown, queue checks, and macOS drive access.
3. **Make pipeline tests portable.** Resolve FFmpeg for the actual host and
   generate disposable fixtures so the six key safety tests no longer skip.
   Exercise restart recovery, SSE shutdown, and review acceptance as well.
4. **Review quality verification failure behavior.** `verify.ts` marks missing
   VMAF measurements as skipped; an encode can still replace the original if
   other checks pass. A policy decision is needed on holding those for review.
5. **Check legacy-container review acceptance.** Automatic conversion supplies
   the new extension to `replaceInPlace`, but `Queue.accept` omits that
   destination. An accepted legacy-container output can retain the old
   extension. Conversion-ledger paths also need checking after renames.
6. **Deploy the investigated encode fixes when requested.** The retained
   `.m4v` failure was reproduced and fixed in the working copy, along with
   hidden error details and a timestamp-alignment bug in VMAF. See
   [Encoding investigation](ENCODING-INVESTIGATION.md) for isolated 4K results,
   validation, and limitations. These changes are not live yet. Configure
   library integrations only if wanted; preserve the existing preset.
