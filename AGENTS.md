# Working on Convertly

Convertly is an operational media converter, not a read-only prototype. It
can replace real library files. Treat development and production as separate
environments even when they share a machine.

## Read first

- `CLAUDE.md` records the product decisions, measurements, and their rationale.
  Preserve those decisions when working in Codex; the filename does not make
  them obsolete.
- `docs/OPERATIONS.md` records the deployment discovered on 2026-08-30, safe
  service control, validation results, and known risks. Recheck live state;
  its PIDs and queue counts are a dated snapshot.
- `README.md` covers setup and configuration.

## Runtime safety

- `/Users/nikobe/Local/convertly` was the live server's working directory at
  handover. Check the listener on port 8973 before running anything here.
- Do not run `npm start`, `npm run dev`, or the deploy script merely to inspect
  the app. Startup opens/migrates SQLite, deletes temporary outputs, sweeps
  expired quarantine, requeues interrupted jobs, and starts queued work.
  Legacy versions performed cleanup/database effects **before** binding their
  port. The restart-safety changes reserve the port and lock the data directory
  first, and were activated on this Mac on 2026-08-30. Verify the running instance
  with `npm run service:status`; do not rely on the dated rollout snapshot.
  Development still needs independent media roots and database state.
- Tests and development servers must use disposable media roots and a separate
  `dataDir`, config, and port. Never copy the live queue into a test environment
  while leaving its real media paths intact.
- The Vite dev proxy targets port 8973 by default. Point it at the isolated API
  when doing UI development; otherwise UI actions reach production.
- A normal build replaces `dist/web`, which the live process serves directly.
  For validation here, build to a unique temporary directory instead.
- Do not restart, deploy, retry jobs, accept encodes, or clean media as a side
  effect of an investigation. When service changes are requested, inspect the
  queue first and use the operating procedure.
- Never commit local configuration, credentials, SQLite files, logs, media,
  temporary outputs, or quarantined originals. Do not dump secrets into logs.

## Product invariants

- Aim for smaller files at the same perceived picture quality. Preserve the
  user's stored preset; the built-in CRF 20 is not necessarily the active CRF.
- Exactly one encode at a time. Use width-based resolution classification:
  software x265 for 1080p and below, VideoToolbox for 4K on the reference Intel
  Mac mini. Do not introduce AV1 or change this policy without new measurements
  and agreement on the product change.
- `shouldReplaceAudio` defines audio treatment. Copy Atmos untouched, never
  upmix stereo, and use the explicit 7.1-to-5.1 downmix where required.
- Keep filename, container, mtime, and permissions wherever supported. Legacy
  containers that cannot carry HEVC require the explicit `.mkv` exception.
  Never invoke Sonarr/Radarr renaming as part of conversion.
- Encode beside the original, verify, then quarantine and replace on the same
  volume. Retain originals for 14 days using Convertly's filename timestamp,
  never ctime. Library-manager notifications are best effort after replacement.
- Route client paths through `resolveWithinRoots`; preserve the IP allowlist.
  There is no login, so do not expose the app publicly or relax access rules.
- Preserve the amber terminal design, Departure Mono, square corners, and
  palette tokens in `src/web/styles.css` unless a redesign is requested.

## Code map

| Area | Main files |
| --- | --- |
| Startup, config, access | `src/server/index.ts`, `config.ts`, `access.ts`, `paths.ts` |
| Instance ownership and local control | `src/server/instance.ts`, `src/server/service.ts` |
| API and events | `src/server/routes/api.ts` |
| Persistence | `src/server/db.ts` — built-in `node:sqlite`, WAL mode |
| Library and estimates | `scanner.ts`, `probe.ts`, `classify.ts`, `src/shared/estimate.ts` |
| Queue and scheduling | `src/server/queue.ts`, `governors.ts`, `src/shared/governors.ts` |
| Conversion safety | `ffmpeg-args.ts`, `encoder.ts`, `pipeline.ts`, `verify.ts`, `replace.ts` |
| Library notifications | `src/server/integrations.ts` |
| React interface | `src/web/App.tsx`, `src/web/TrackPanel.tsx`, `src/web/QualityPanel.tsx`, `src/web/QueuePanel.tsx` |

Otherwise unqualified filenames in the table are relative to `src/server/`.

## Validation

Use Node 24+ (`.nvmrc` is 24). Server TypeScript runs natively; keep syntax
erasable and use `.ts` import extensions. No server compilation is required.

```sh
npm test
npm run typecheck
convertly_build_dir=$(mktemp -d /private/tmp/convertly-build.XXXXXX)
npm run build -- --outDir "$convertly_build_dir"
```

Report skipped tests, not just the exit code. At handover the six pipeline
tests skipped because they require `/opt/homebrew/bin/ffmpeg` and an ignored
media fixture; the actual Intel host uses `/usr/local/bin/ffmpeg`. Use
disposable fixtures for new conversion tests, never the production library.

`startup.test.ts` tests port collisions, database ownership, crash recovery,
review preservation, pause races, and local service commands. These tests need
loopback sockets and OS process inspection (`lsof`/`ps`), and use only temporary
libraries/databases. Request the appropriate sandbox permission rather than
silently skipping this coverage. Never delete `instance.sqlite` while running;
replacing its inode would defeat the process lock.

Keep fixes focused and add regression coverage for changes to replacement,
queue recovery, verification, path access, or encoding policy. Documentation
changes do not need new tests. Use `codex/` when creating a development branch.
