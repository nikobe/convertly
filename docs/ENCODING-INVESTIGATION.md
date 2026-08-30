# Encoding investigation — 2026-08-30

These fixes are in the working copy on `codex/restart-safety`. They have not
been deployed. The server started at 10:57 UTC remains running, with its queue
paused and the failed job unchanged. No production conversion was retried.

## Retained failure: an M4V muxer problem

The failed queue item is **The Hobbit — There, And Back Again**, an H.264
1920×800 M4V with AAC stereo. It is not 4K. Its queued preset is CRF 20,
although the current default preset is CRF 22; the reproduction used the
job's saved settings.

A disposable 30-second stream-copy excerpt reproduced the error immediately:

```text
Could not find tag for codec hevc in stream #0, codec not currently supported in container
```

FFmpeg inferred its legacy `ipod` muxer from `.m4v`, and that muxer rejects
HEVC. Selecting `-f mp4` explicitly fixes the failure while keeping the M4V
filename and MPEG-4 container family. Other planned containers now also have
an explicit muxer. The existing `hvc1` tag and audio treatment remain intact.

The repaired excerpt encoded in 51.5 seconds, decoded without errors, kept
AAC stereo, and shrank from 17,078,530 to 10,271,953 bytes (**39.9% smaller**).
After the verification fix below, all seven checks passed, with VMAF **96.82**
against the unchanged floor of 93. This is a sample result, not a claim that
the entire four-hour film has been converted or verified.

## Error messages were hiding the cause

Previously the queue saved only FFmpeg's last stderr line, usually the generic
"Nothing was written" epilogue. It now keeps the opening three error lines
(bounded to 1,500 characters). The encoder's bounded stderr retains the start
and end of a long log, so the cause is not discarded by later messages.

## Quality comparison was sometimes matching adjacent frames

FFmpeg's default frame synchronization chooses the nearest **earlier**
reference timestamp. Different muxer time bases can round the same frame's
timestamp a few microseconds apart, causing a comparison with the preceding
picture. Resetting each independently sought input to its own first frame
can also align different pictures.

The comparison now uses a common time base, preserves the shared seek-relative
timeline, and selects the nearest reference timestamp. It does not search
for matching content, change the encoder, or relax the quality threshold.

Evidence:

- A generated clip remuxed without changing its compressed pictures scored
  **74.80** with the previous verifier. The new regression requires over 99.
- The same regression deliberately shifts the content by five frames and
  verifies that it is still held for review below 93.
- The Hobbit sample's original three-window result was **42.70**. Correct
  timestamp matching gives **96.82** on the same encoded file.

## 4K hardware encoding works, but the tested preset loses too much quality

The isolated 4K test used **Alien ³ — The Legacy Cut**, a 3840×1620 SDR,
8-bit HEVC source. The Mac mini successfully encoded both a short excerpt
and a five-minute excerpt with `hevc_videotoolbox`, 10-bit output, no
downscaling, and the stored CRF 22 preset. The selected bitrate was
13,841,020 bits/second. The longer encode ran at roughly 40 frames/second.

The five-minute cut includes a subtitle tail, so its container duration is
306.01 seconds. Its output was 305.93 seconds, a 0.08-second difference.
All four audio tracks and the subtitle track survived, and the entire output
decoded without errors. It shrank from 883,522,381 to 596,651,183 bytes
(**32.5% smaller**).

The corrected quality comparison scored **83.16**, below the floor of 93.
This result must remain a review item, not an automatic replacement. The
source is already HEVC; a working hardware encoder does not guarantee useful
savings at the required quality for every source.

The 4K measurement used three five-second quality windows, alongside a full
decode of the five-minute output. The original longer quality measurement
was stopped after the timestamp bug was discovered. The production default
of 120 sampled seconds has not changed. A separate five-second comparison
aligned from the start also scored below the threshold (86.46), supporting
that this 4K result is not just the earlier timestamp-rounding problem.

A further **test-only CRF 16** trial on the short 4K excerpt raised the target
bitrate to 19,503,256 bits/second. It encoded in 19.0 seconds and passed the
structural/decode checks, but VMAF was still **89.47**, below 93. Its output
was 89,290,139 bytes from 106,341,379 (**16.0% smaller**). This again used
three five-second quality windows. The different sample windows mean these
scores are not a controlled CRF quality curve. Neither tested 4K setting is
approved for automatic replacement of this source; no production preset was
changed. These trials establish working hardware encoding, not an acceptable
quality/savings balance for every 4K file or a reason to lower the threshold.

HDR, Dolby Vision, Atmos preservation on these particular clips, sustained
feature-length thermal behavior, and other failing 4K titles were not tested.
No 4K FFmpeg initialization failure was reproduced with this source.

## Validation and safety

- Full suite: **167 passed, 0 failed, 6 skipped** (173 tests), run serially
  with the required loopback/process permissions.
- New generated-media tests execute on `/usr/local/bin/ffmpeg`; no ignored
  private fixture is needed for the M4V or timestamp regressions.
- The six existing fixture-based pipeline tests still skip. This does not
  constitute testing every production replacement path end to end.
- Server and web type checks passed. A build passed in a unique temporary
  output directory; live `dist/web` was not overwritten.
- Failed queue row, saved default preset, conversion count (172), and recorded
  savings were unchanged. Both original media files retained their size and
  mtime. Tests wrote only disposable excerpts and outputs.
- All real-media runs were dry runs or direct encodes to the test folder;
  nothing was accepted, quarantined, or replaced in the production library.

Temporary commands, diagnostic logs, probe data, and sample outputs are under
`/private/tmp/convertly-encode-investigation-1sPmee`. They are intentionally
outside Git and can disappear on restart. Tests ran on Node 24.15.0 and
FFmpeg/ffprobe 9.0.1 on the Intel Mac mini.

The separate existing concern about skipped/failed VMAF measurements permitting
replacement remains open; these fixes do not change that policy. Both real
sample conclusions above are based on actual numeric measurements, not skips.
