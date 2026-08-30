# Convertly

A local web console for browsing a Plex/Jellyfin library across several
drives and re-encoding files smaller at the same picture quality.

These design decisions also apply to work in Codex. Read `AGENTS.md` for
development safeguards and `docs/OPERATIONS.md` for the deployment and current
known issues. The operating snapshot was established on 2026-08-30.

## Locked decisions — do not relitigate these without asking

**What this app is for: smaller files from a newer video codec, at the same
picture quality.** Audio is secondary — it is fixed only where it actually
causes trouble, and never at the cost of making the file bigger.

**Audio: `shouldReplaceAudio` is the whole rule.** A track is re-encoded to
AC3 if, and only if, it carries no Atmos *and* one of these holds:

- the codec misbehaves downstream — the DTS family
- it is lossless, and therefore enormous — TrueHD, PCM, FLAC
- it is wider than 5.1, which is channels this chain cannot use

Consequences worth stating plainly, because each was got wrong once:

- **Atmos is copied untouched and nothing is added beside it.** The playback
  client decodes and downmixes it without complaint, and an added AC3 track
  costs ~576 MB on a two-hour film to solve a problem that does not exist
  here. Atmos beats every other reason to touch a track, including 7.1.
- **Stereo is left alone, and never upmixed.** `outputChannels` caps but never
  raises. A stereo track that does need re-encoding (stereo DTS) gets 224k,
  not the 640k that belongs to 5.1 — see `ac3BitrateFor`.
- **7.1 gets an explicit, correctly weighted 7.1→5.1 downmix**, not ffmpeg's
  default fold, which leaves dialogue sitting too low against the surrounds.
- **Video and audio are independent.** An H264 file whose audio must be left
  alone is still worth converting. Letting an audio constraint veto the video
  encode was a bug, not a policy.

**Video: split on resolution.** 1080p and below uses `libx265` (CRF 20,
preset medium, 10-bit). 2160p uses `hevc_videotoolbox` (10-bit). This is a
measurement, not a preference — see "Host" below.

The split goes through `resolutionClass(width, height)`, which keys on
**width**. Film is letterboxed: a 2:1 1080p transfer is 1920×960 and a scope
one is 1920×800. Judging by height labelled those 720p, and would have routed
a letterboxed 4K master to software x265 — a ten-hour job on the target host.

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
   *(Built: `integrations.ts`. The item is found by matching the file against
   each library folder, longest match first — the filename is what we keep
   identical, so it identifies nothing.)*
6. Refresh the folder in Plex. Its periodic scan looks for added and removed
   files, and analysis runs on add; with the path and mtime unchanged nothing
   prompts a re-analysis, and Plex picks direct play against transcode from
   that stored codec info. *(Built.)*

All of step 5 and 6 is best-effort and never fails a job: by then the swap is
verified and the library is right on disk. A server being down is a stale
database. Failures are reported on the queue item and in the health strip.

Step 5 matters because Sonarr only re-reads mediainfo when a filename changes,
so an in-place swap otherwise leaves its database describing a file that no
longer exists.

**Container:** `planContainer` decides. MKV stays MKV and MP4/M4V/MOV keep
their own container (with `-tag:v hvc1`, without which Apple players silently
refuse HEVC). **AVI and the other legacy containers cannot carry HEVC at all**,
so those become `.mkv` and the filename necessarily changes — the alternative
was a Matroska file wearing an `.avi` extension, which is a lie on disk. That
case is flagged in the UI before queueing, and the quality tokens in the name
survive, so a rescan should re-import at the same quality.

Always pass the planned muxer explicitly. In particular, `.m4v` needs
`-f mp4`: FFmpeg's extension-based guess selects the older `ipod` muxer,
which rejects HEVC even with `hvc1`. This was reproduced on the Intel host
on 2026-08-30; keeping `.m4v` with the MP4 muxer preserves the filename.

**Never:** gratuitously change the container (mkv→mp4 is a filename change for
no reason); call
`RenameMovie`/`RenameSeries` afterwards (a naming scheme containing
`{MediaInfo VideoCodec}` will rewrite the file to say `h265` and re-score it);
unmonitor items "to be safe"; or delete an original before quarantine expires.

## Reference host

Every encoder decision below is tuned for one deployment target: an Intel
Mac mini 2018, Core i5-8500B 6C/6T, UHD 630 Quick Sync Gen 9.5, 8 GB RAM,
macOS 15. On different hardware, re-measure before trusting any of it.

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

**Sustained multi-hour encoding will thermally throttle in a small enclosure.**
Derive ETAs from rolling measured throughput on the running job, never from
the table above.

**Measured on the real host, 23–24 Aug 2026.** Four films and episodes,
`libx265 medium crf22`, four hours of continuous encoding sampled every 30s:

| | |
| --- | --- |
| Sustained rate | ~0.6× realtime mean (depressed ~31% by a governor bug at the time) |
| `CPU_Speed_Limit` | dropped to **80** — the enclosure does genuinely throttle |
| `machdep.xcpm.cpu_thermal_level` | median 100, **max 109** — tracks load, not throttling |
| Size reduction | 63% to 89% |
| VMAF | 94.33 to 97.31, floor 93 |

The throttling is real, so the thermal governor earns its place — but only on
`CPU_Speed_Limit`. The level reading exceeds 100 and sits pegged whenever the
CPU is busy, which is exactly when it would be consulted. ETAs must still come
from the running job.

### Host gotchas

- **This ffmpeg build rejects `-b:v 5M`.** Emit integers: `-b:v 5000000`.
- **8 GB shared with a media server.** 4K jobs are memory-tight. No generous
  buffers.
- **Pin our own ffmpeg.** Do not depend on a media server's bundled copy — for
  example `/Applications/Jellyfin.app/Contents/MacOS/ffmpeg` — since an update
  can replace or remove it. Record the version alongside every job.
- **No 4:2:2, 4:4:4, lossless or alpha** on the hardware HEVC path.

## Architecture

Single Node process. **Node 24+ is required** — the server is TypeScript run
natively via type stripping, with no build step. That means no parameter
properties, enums, or namespaces in server code; `erasableSyntaxOnly` is on so
`npm run typecheck` catches violations.

- `src/shared/` — types used by both server and client
- `src/server/` — Fastify API, `node:sqlite` store, ffprobe scanner
- `src/web/` — React + Vite UI, built to `dist/web` and served by Fastify

There is **no authentication**. Reachability is the access control: an
`onRequest` hook rejects any client outside `allowedClients`, which defaults
to loopback plus `100.64.0.0/10` — the range Tailscale assigns. `host`
defaults to `0.0.0.0` for the same reason: the two settings only make sense
together, and there is a test asserting the pair stays reachable-but-closed.
The only thing a config *must* contain is `roots`. That makes the
app usable over a tailnet without handing the local network a button that
re-encodes media in place. Rules are validated at config load, because a typo
parsing as "allow everything" is the dangerous failure.

`paths.ts` is the security boundary: every client-supplied path goes through
`resolveWithinRoots`, which canonicalises through realpath before checking, so
a symlink inside a root cannot be used to escape it. Nothing should touch the
filesystem without going through it.

## Build phases

1. **Probe and browse** — built; browsing does not replace media.
2. One file end to end — built: command builder, encode runner, verification,
   quarantine, replacement, and optional Arr/Plex notifications. The UI queues
   jobs that run through `runJob`.
3. The queue *(built)*: persistent in SQLite, SSE progress, pause/resume,
   cancel, add-while-running, accept/discard per item.
4. Governors *(built)*: time window, batch rhythm, thermal ceiling,
   playback-aware pause, disk guard.
5. Polish — savings ledger, estimates, and review queue are built. Smart lists
   and a sample-encode estimator remain possible extensions, not current features.

## Audio and subtitle track selection

Real releases carry a pile of foreign-language dubs: one test file had eight
5.1 dub tracks plus an English stereo original, where the dubs alone were
1.8 GB of a 5.3 GB file — more than the video re-encode saves. Dropping them
took that file from 5.3 GB to 1.9 GB.

So `primaryAudio` in `src/shared/estimate.ts` does not pick on channel count.
Precedence is explicit preferred language, then untagged, then channels, then
the default flag — on a foreign release the untagged 5.1 is usually itself a
dub, so an explicit preferred-language tag has to beat a wider untagged
track.

The browse screen expands each file into a track chooser. Its choices update
the projection and are recorded when queueing, then honoured by the ffmpeg
command builder. The chosen primary is shown so it can be overridden per file.
The heuristic is a good default, not a certainty.

`estimate.ts` is shared by server and client precisely so the row total and
the panel can never disagree.

A season is the working unit, not a file: the header checkbox takes the whole
folder, shift-click takes a range, and "apply to selected" copies one file's
track choices onto every other selected file **with a matching track layout**.
Layout is compared by ordered codec, channel count and language. Files that
differ are skipped and counted in the status line rather than guessed at — an
extended cut with a different mux must not silently inherit choices made for
a standard episode.

## Quality controls and presets

Quality is a control, not just a default. The HUD shows the active setting and
opens a panel with picture quality, encoder speed, downscale, replacement
audio bitrate and 10-bit.

**Changes persist to the `presets` table automatically**, debounced, with no
save button. Deliberately server-side rather than in the browser: the queue
runs jobs unattended and reads the stored preset, so a browser-only copy would
be a second source of truth that could disagree with the one actually used.
The built-in `DEFAULT_PRESET` is only the fallback when nothing is stored.

- CRF is exposed by what it *does* ("Same quality", "Very good", "Good"), with
  the raw number shown alongside. A bare "20" tells nobody anything.
- **Changing quality moves the projected size in every row**, via `crfFactor`
  (six CRF steps ≈ double or halve the bitrate). A control that did not move
  the number it claims to control would be worse than no control.
- **Downscale asks twice.** Resolution is the only setting a later re-encode
  cannot undo, so it needs a deliberate second click and stays off by default.
- The server validates presets independently of the UI, so a stale client or a
  hand-rolled request cannot produce a nonsense ffmpeg command.

## The queue

`queue.ts` drains it one job at a time — concurrency 1, for the reason in
"Locked decisions". The queue is a table, not an in-memory list, so a crash or
a power cut mid-batch resumes where it stopped: anything still marked
`running` at startup is requeued, since a process that died did not finish it.

- Adding is a batch operation that reports what it *skipped* and why, rather
  than failing the lot because one file is already queued. Files with nothing
  to do are refused at that point — queueing one burns an encode producing a
  copy that then fails the size gate.
- `path` is unique in the table, so the same file cannot be queued twice and
  have two encodes race for one output.
- Pause lets the running job finish and starts nothing new. Cancel aborts the
  running one; the original is untouched either way.
- Pause is now persisted in SQLite, so a controlled restart does not silently
  resume a batch. A governor check already in flight rechecks pause before
  starting the next encode.
- A `review` item keeps its encode on disk, so accepting later costs no
  re-encode. Removing or discarding it deletes that file rather than orphaning
  it.

Startup reserves the HTTP port and holds a separate SQLite instance lock before
opening the application store or sweeping media. The lock is released by the OS
on exit or crash; its file must not be deleted while running. The startup temp
sweep preserves every directory containing a persisted pending output,
including review encodes and their sidecars. `src/server/service.ts` provides
local process controls. These changes were activated on the Mac mini on
2026-08-30; `docs/OPERATIONS.md` records the rollout and historical deployment.

## Governors

`governors.ts` decides whether the queue may work. The pure rules are in
`src/shared/governors.ts` so they are testable without a clock, a thermometer
or a media server.

- **A held queue does not spin.** It stops and a 30-second timer re-checks, so
  waiting out an overnight window costs nothing.
- **A governor turning hostile mid-encode suspends the process**, it does not
  kill it — `SIGSTOP` loses no work, which is what makes a 15-second check
  affordable.
- **Windows crossing midnight are the normal case** (22:00–06:00). Treating
  the window as a simple range would mean it never opened.
- **Thermal defaults to `CPU_Speed_Limit` from `pmset -g therm`**, backing off
  below 70. `machdep.xcpm.cpu_thermal_level` is displayed but its optional ceiling
  is off by default: it tracks load rather than throttling on this Intel host.
  Never substitute load average. With no sensor the governor reports that and
  stands aside rather than blocking.
- **The disk guard assumes the worst case**: the encode is written beside the
  original, so both exist at once and the output might not be smaller.
- Defaults: thermal, playback and disk on; window and rhythm off, because they
  stop work happening and should be asked for.

## The encode pipeline

`runJob` in `pipeline.ts` is the whole of it: build, encode, verify, swap, in
that order and never out of it. Nothing touches the original until every check
has passed. A failure leaves the library byte-for-byte as it was; a `review`
outcome keeps the encode so accepting it later costs no re-encode.

- `ffmpeg-args.ts` is pure — the entire policy is testable without encoding a
  frame. It is also where the integer-bitrate rule lives, with a test that
  fails if any SI-suffixed number could ever reach ffmpeg.
- **Keyframes are forced every 5 seconds** (`-g` from the source frame rate).
  x265's default of 250 frames plus scene detection turned a source's steady
  2-second cadence into irregular gaps of up to 20 seconds. That makes Plex
  scrubbing coarse and, worse, stops Jellyfin's HLS segment boundaries landing
  on keyframes, which turns a direct stream into a transcode.
- `encoder.ts` parses `-progress pipe:1`. **Progress is measured from `frame=`
  against duration × fps, never from `out_time`.** `out_time` is the muxer's
  furthest-written timestamp, and a stream-copied audio track is written far
  ahead of the encode: on a 2-minute file it read 64s — 53% — after eight
  video frames, so the bar jumped to half instantly, sat there, then finished
  abruptly. There is a test asserting the published fraction derives from the
  frame count.
- Keep both the start and end of bounded FFmpeg stderr, and show the opening
  error lines in failed-job messages. The final "Nothing was written" line
  alone concealed the actual unsupported-container error.
- **ETA comes from frames per second measured over a trailing 120-second
  window**, never a static figure — the target host throttles, so a rate sampled in
  the first minute is a lie by hour three. Nothing is published until 20s of
  samples exist. `pause()`/`resume()` are SIGSTOP/SIGCONT, so governors are
  cheap.
- `verify.ts` gates on readability, duration drift, track census, chapters, a
  full decode sweep, size delta and mean VMAF over three sampled windows.
  `fail` aborts; `review` holds for a human. **It reports stages**, because on
  a feature it is a large slice of total time and used to look like a hang:
  the job sat in `encoding` with a frozen bar for the whole of it. The decode
  sweep reports a real percentage; the VMAF windows are counted off.
- VMAF comparisons keep a common seek-relative timeline and use
  `ts_sync_mode=nearest`. Container time bases round differently; selecting
  the preceding reference frame for a microsecond difference produced a score
  of 74.8 for identical pictures. Independently resetting each input's first
  sampled frame to zero can also misalign a seek. Nearest timestamp matching
  fixes both without searching for similar content or relaxing the floor of
  93. The regression also checks that deliberately shifted content fails.
- `replace.ts` is the arr-safety boundary. Same-volume rename only — a
  cross-volume swap is refused rather than silently becoming a copy — then
  mtime and mode are restored. `sweepQuarantine` only ever looks inside a
  directory literally named `.convertly-quarantine`, and there is a test
  asserting a bystander file is never swept.

Quarantine retention is 14 days, judged by the timestamp in the quarantined
filename — never by file metadata. Renaming a file into quarantine does not
update `ctime` on exFAT or network volumes, so originals from old releases
read as years old and were swept on the next restart, minutes after being
quarantined. A file in a quarantine directory without a stamp we wrote is
never deleted.

## Design

Single committed dark theme — an amber phosphor terminal, science-fiction-terminal-adjacent, no
light variant. Departure Mono throughout. Palette tokens live at the top of
`src/web/styles.css` and are the single source of truth for the theme. Square corners, hairline rules, corner ticks — no rounded cards.
