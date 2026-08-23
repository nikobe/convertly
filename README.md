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
| `host` / `port` | Where to listen. Keep it on your LAN. |
| `roots` | The only folders the app can read. Each needs `id`, `label`, `path`. |
| `ffprobePath` / `ffmpegPath` | Explicit binary paths. Omit to auto-detect. |
| `scanConcurrency` | Parallel ffprobes during a scan. Default 4. |
| `videoExtensions` | Which extensions count as video. |

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
