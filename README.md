# Convertly

Browse a Plex/Jellyfin library, see what is worth re-encoding, and convert it
smaller at the same picture quality — without Sonarr or Radarr ever deciding a
file went missing.

**Phase 01: read-only.** It probes and reports. It cannot alter a byte.

## Requirements

- **Node 24 or newer** (the server is TypeScript, run natively)
- **ffprobe** — and ffmpeg from phase 02 onward

## Setup

```sh
npm install
cp config/convertly.example.json config/convertly.json
# edit config/convertly.json and point "roots" at your media folders
npm run build     # builds the web UI
npm start
```

Then open http://localhost:8973.

For development, `npm run dev` runs the API with `--watch` and Vite's dev
server on port 5273, proxying `/api` to the API.

## Configuration

| Key | Meaning |
| --- | --- |
| `host` / `port` | Interface to bind. `127.0.0.1` for this machine only, `0.0.0.0` to be reachable from elsewhere. |
| `allowedClients` | Addresses permitted to use the API. Exact IPs or IPv4 CIDR. `"*"` disables the check. |
| `roots` | The only folders the app can read. Each needs `id`, `label`, `path`. |
| `ffprobePath` / `ffmpegPath` | Explicit binary paths. Omit to auto-detect. |
| `scanConcurrency` | Parallel ffprobes during a scan. Default 4. |
| `videoExtensions` | Which extensions count as video. |
| `radarr` / `sonarr` | `{ "url": "...", "apiKey": "..." }`. Optional. |
| `plex` | `{ "url": "...", "token": "..." }`. Optional. |

## Telling Radarr, Sonarr and Plex

Optional, and off until you add credentials:

```json
{
  "radarr": { "url": "http://localhost:7878", "apiKey": "..." },
  "sonarr": { "url": "http://localhost:8989", "apiKey": "..." },
  "plex":   { "url": "http://localhost:32400", "token": "..." }
}
```

After a file is replaced, the owning item is rescanned. This is needed because
Sonarr and Radarr only re-read a file's mediainfo when its **filename**
changes — and keeping the filename identical is exactly what stops them
re-downloading. Without a rescan their databases go on describing the file
they imported.

Plex is the same problem wearing a different hat: its periodic scan looks for
*added and removed* files, and analysis — which records codec and bitrate —
runs when an item is added. Since the path and mtime are unchanged, nothing
prompts a re-analysis, and Plex decides direct-play against transcode from
that stale information.

Failures here never fail a job. By that point the swap is done and verified;
an unreachable server is a stale database, not a lost file. It says so in the
queue and in the health strip.

## Reaching it from another machine

Nothing to configure. On start it prints where it can be reached:

```
open http://localhost:8973/
open http://100.71.126.16:8973/ (tailnet)
accepting: 127.0.0.1, ::1, 100.64.0.0/10
```

There is no password. The app can overwrite and delete media, so reachability
*is* the access control: it binds every interface, but only accepts this
machine and `100.64.0.0/10` — the range Tailscale assigns. A tailnet device
can use it; the local network gets 403.

To allow something else, list it: `"allowedClients": ["127.0.0.1", "::1",
"100.64.0.0/10", "192.168.1.20"]`. `"*"` turns the check off, and the health
strip shows red when it is.

What you browse is always the *server's* filesystem, so from anywhere you are
looking at the host's drives. Bookmarks live in the server's database, so they
follow you between devices.

`roots` is a hard boundary, not a convenience: every path the client asks for
is canonicalised and checked against it, so the app cannot read or write
outside those folders even if asked.

## Commands

```sh
npm test        # unit tests
npm run typecheck
npm run build
npm start
```

## Credits

The interface uses [Departure Mono](https://departuremono.com) by Helena Zhang,
bundled here under the SIL Open Font License 1.1 — see
[`resources/DepartureMono-OFL.txt`](resources/DepartureMono-OFL.txt).
