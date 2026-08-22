# Convertly

A local web console for browsing Plex/Jellyfin media across three drives on a
Mac mini and re-encoding files smaller at the same picture quality.

## Locked decisions — do not relitigate these without asking

**Audio: AC3 640k 5.1, replacing the original track.** The target chain is plain
Dolby Digital playback clients — no DD+/EAC3 — so 640k is the ceiling and the
universally compatible choice. A 7.1 source needs an explicit, correctly
weighted 7.1→5.1 downmix, not ffmpeg's default fold, which leaves dialogue
sitting too low against the surrounds.

**Video: split on resolution.** 1080p and below uses `libx265` (CRF 20,
preset medium, 10-bit). 2160p uses `hevc_videotoolbox` (10-bit). This is a
measurement, not a preference — see "Host" below.

**Concurrency: exactly 1.** Measured, not assumed: two parallel hardware jobs
aggregate 82 fps against 91 fps for one. There is a single media engine, and
software x265 already saturates all six cores.

**AV1: dropped.** Quick Sync Gen 9.5 has neither AV1 encode nor decode.

**Files are replaced in place under a byte-identical name.** See below.

## The Sonarr/Radarr constraint — the most important thing here

Neither app inspects file contents. A re-download happens only when the
quality is below the profile cutoff, the custom-format score is below
"Upgrade Until", or a disk scan finds the file missing. **After import, both
quality and custom formats are scored from the filename, not from mediainfo.**

So an in-place H264→HEVC and DTS→AC3 swap changes the score by nothing,
provided the name and extension stay byte-identical. The stale `x264 DTS-HD`
tokens left in the filename are working *for* us.

The replace protocol:

1. Encode to a temp file on the same volume (`.convertly-tmp/`) so the final
   move is an atomic rename, never a cross-disk copy.
2. Verify. Only then proceed.
3. Move the original to quarantine; rename the new file to the byte-identical
   original name, extension included.
4. Restore the original mtime and permissions.
5. `POST /api/v3/command {"name":"RescanMovie","movieId":N}` — disk-only, no
   metadata-provider hit. Sonarr uses `RescanSeries` with `seriesId`.
6. Refresh and re-analyse the item in Plex.

Step 5 matters because Sonarr only re-reads mediainfo when a filename changes,
so an in-place swap otherwise leaves its database describing a file that no
longer exists.

**Never:** change the container (mkv→mp4 is a filename change); call
`RenameMovie`/`RenameSeries` afterwards (a naming scheme containing
`{MediaInfo VideoCodec}` will rewrite the file to say `h265` and re-score it);
unmonitor items "to be safe"; or delete an original before quarantine expires.

## Host (production target)

Intel Mac mini 2018, Intel Core i5-8500B 6C/6T, UHD 630 Quick Sync
Gen 9.5, 8 GB RAM, macOS 15.7.7, Jellyfin running on the same box.

Measured throughput, 10-second bursts on a cold machine:

| Job | Encoder | Burst | Sustained est. |
| --- | --- | --- | --- |
| 1080p | `hevc_videotoolbox` 8-bit | 92.4 fps (3.08×) | — |
| 1080p | `hevc_videotoolbox` 10-bit | 92.2 fps (3.07×) | — |
| 1080p | `libx265` medium crf23 | 26.5 fps (0.88×) | ~0.6× |
| 2160p | `hevc_videotoolbox` 10-bit | 32.9 fps (1.10×) | ~0.75× |

10-bit costs nothing on the hardware path. Hardware is only ~3.5× faster than
software at 1080p, which is why software wins there; at 4K, software x265 is
~0.2× realtime and hardware is the only viable option.

**Sustained multi-hour encoding will thermally throttle in that enclosure.**
Derive ETAs from rolling measured throughput on the running job, never from
the table above.

### Host gotchas

- **This ffmpeg build rejects `-b:v 5M`.** Emit integers: `-b:v 5000000`.
- **8 GB shared with Jellyfin.** 4K jobs are memory-tight. No generous buffers.
- **Pin our own ffmpeg.** The only one on the box is Jellyfin's bundled copy at
  `/Applications/Jellyfin.app/Contents/MacOS/ffmpeg`, which a Jellyfin update
  can replace or remove. Record the version alongside every job.
- **No 4:2:2, 4:4:4, lossless or alpha** on the hardware HEVC path.

## Architecture

Single Node process. **Node 24+ is required** — the server is TypeScript run
natively via type stripping, with no build step. That means no parameter
properties, enums, or namespaces in server code; `erasableSyntaxOnly` is on so
`npm run typecheck` catches violations.

- `src/shared/` — types used by both server and client
- `src/server/` — Fastify API, `node:sqlite` store, ffprobe scanner
- `src/web/` — React + Vite UI, built to `dist/web` and served by Fastify

`paths.ts` is the security boundary: every client-supplied path goes through
`resolveWithinRoots`, which canonicalises through realpath before checking, so
a symlink inside a root cannot be used to escape it. Nothing should touch the
filesystem without going through it.

## Build phases

1. **Probe and browse** — read-only. *(current)*
2. One file end to end: presets, encode, verify, quarantine, atomic replace,
   arr rescan, Plex refresh. **Includes acting on track selections** — see
   below.
3. The queue: persistent, SSE progress, pause/resume/cancel, add-while-running.
4. Governors: time window, batch rhythm, thermal ceiling, playback-aware
   pause, disk guard.
5. Polish: smart lists, savings ledger, sample estimator, review tray.

## Audio and subtitle track selection

Real releases carry a pile of foreign dubs: one test file had eight foreign-language
5.1 tracks plus an English stereo "Original Mono Mix", where the dubs alone
were 1.8 GB of a 5.3 GB file — more than the video re-encode saves. Dropping
them takes that file from 5.3 GB to 1.9 GB.

So `primaryAudio` in `src/shared/estimate.ts` does not pick on channel count.
Precedence is explicit preferred language, then untagged, then channels, then
the default flag — on a foreign release the untagged 5.1 is usually itself a
dub, so an explicit `eng` tag has to beat a wider untagged track.

The browse screen expands each file into a track chooser. It is projection
only in phase 01; phase 02 must honour the recorded selection when building
the ffmpeg command, and must show the chosen primary so it can be overridden
per file. The heuristic is a good default, not a certainty.

`estimate.ts` is shared by server and client precisely so the row total and
the panel can never disagree.

A season is the working unit, not a file: the header checkbox takes the whole
folder, shift-click takes a range, and "apply to selected" copies one file's
track choices onto every other selected file **with a matching track layout**.
Layout is compared by ordered codec, channel count and language. Files that
differ are skipped and counted in the status line rather than guessed at — an
extended cut with a different mux must not silently inherit choices made for
a standard episode.

## Design

Single committed dark theme — an amber phosphor terminal, Sample Feature-adjacent, no
light variant. Departure Mono throughout. Palette tokens live at the top of
`src/web/styles.css`; the reference images that produced them are in
`reference/`. Square corners, hairline rules, corner ticks — no rounded cards.
