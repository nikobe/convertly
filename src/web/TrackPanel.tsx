import type { DirEntry, AudioTrack, SubtitleTrack } from "../shared/types.ts";
import { primaryAudio, AUDIO_REPLACE, PREFERRED_LANGUAGES, type Selection } from "../shared/estimate.ts";
import { bytes } from "./format.ts";

interface Props {
  entry: DirEntry;
  blockedReason?: string | null;
  selection: Selection;
  onChange: (next: Selection) => void;
  selectedCount: number;
  isSelected: boolean;
  onApplyToSelection: (selection: Selection) => void;
  onConvert: () => void;
  queued: boolean;
  canConvert: boolean;
}

/**
 * Per-file track chooser. Read-only in phase 01 — it changes the projection,
 * not the file — but the choice it records is what phase 02 will act on.
 */
export function TrackPanel({ entry, blockedReason, selection, onChange, selectedCount, isSelected, onApplyToSelection, onConvert, queued, canConvert }: Props) {
  const probe = entry.probe;
  if (!probe) return null;

  const keptAudio = probe.audio.filter((t) => selection.audio.includes(t.index));
  const primary = primaryAudio(keptAudio);

  const toggleAudio = (index: number) => {
    const has = selection.audio.includes(index);
    // Something has to survive, or there is no film left to watch.
    if (has && selection.audio.length === 1) return;
    onChange({
      ...selection,
      audio: has ? selection.audio.filter((i) => i !== index) : [...selection.audio, index].sort((a, b) => a - b),
    });
  };

  const toggleSub = (index: number) => {
    const has = selection.subtitles.includes(index);
    onChange({
      ...selection,
      subtitles: has ? selection.subtitles.filter((i) => i !== index) : [...selection.subtitles, index].sort((a, b) => a - b),
    });
  };

  const keepAll = () =>
    onChange({ audio: probe.audio.map((t) => t.index), subtitles: probe.subtitles.map((t) => t.index) });

  const keepPreferred = () => {
    const wanted = (lang: string | null) => PREFERRED_LANGUAGES.has((lang ?? "").toLowerCase());
    const audio = probe.audio.filter((t) => wanted(t.language)).map((t) => t.index);
    const subtitles = probe.subtitles.filter((t) => wanted(t.language)).map((t) => t.index);
    const fallback = primaryAudio(probe.audio);
    onChange({
      audio: audio.length > 0 ? audio : fallback ? [fallback.index] : [],
      subtitles,
    });
  };

  const keepPrimaryOnly = () => {
    const only = primaryAudio(probe.audio);
    onChange({ audio: only ? [only.index] : [], subtitles: [] });
  };

  const hasForeign = probe.audio.some((t) => !PREFERRED_LANGUAGES.has((t.language ?? "").toLowerCase()));

  return (
    <div className="tracks">
      <p className="tfullname" title={entry.path}>{entry.name}</p>
      {blockedReason && <p className="tblocked">Excluded — {blockedReason}</p>}

      <div className="tgroup">
        <h3>Video</h3>
        {probe.video ? (
          <div className="track fixed">
            <span className="tno">#{probe.video.index}</span>
            <span className="tcodec">{probe.video.codec.toUpperCase()}</span>
            <span className="tmeta">
              {probe.video.width}×{probe.video.height}
              {probe.video.bitDepth ? ` · ${probe.video.bitDepth}-bit` : ""}
              {probe.video.fps ? ` · ${probe.video.fps}fps` : ""}
              {probe.video.bitrate ? ` · ${(probe.video.bitrate / 1e6).toFixed(1)} Mbps` : ""}
            </span>
            <span className="tnote">always kept</span>
          </div>
        ) : (
          <p className="tempty">No video stream.</p>
        )}
      </div>

      <div className="tgroup">
        <h3>
          Audio <span className="tcount">{keptAudio.length} of {probe.audio.length} kept</span>
        </h3>
        {probe.audio.map((track) => (
          <AudioRow
            key={track.index}
            track={track}
            checked={selection.audio.includes(track.index)}
            isPrimary={primary?.index === track.index}
            onToggle={() => toggleAudio(track.index)}
          />
        ))}
        {probe.audio.length === 0 && <p className="tempty">No audio streams.</p>}
      </div>

      {probe.subtitles.length > 0 && (
        <div className="tgroup">
          <h3>
            Subtitles{" "}
            <span className="tcount">
              {selection.subtitles.length} of {probe.subtitles.length} kept
            </span>
          </h3>
          {probe.subtitles.map((track) => (
            <SubRow
              key={track.index}
              track={track}
              checked={selection.subtitles.includes(track.index)}
              onToggle={() => toggleSub(track.index)}
            />
          ))}
        </div>
      )}

      <div className="tactions">
        {/* The primary action leads: right-aligning it put it off-screen on a
            narrow window, because the table sets a min-width. */}
        {canConvert ? (
          <button className="convert" onClick={onConvert} disabled={queued}>
            {queued ? "In the queue" : "Add to queue"}
          </button>
        ) : (
          <span className="tnote">{blockedReason ? "Excluded, see above." : "Nothing to do on this file."}</span>
        )}
        <span className="tdivider" aria-hidden="true" />
        <button onClick={keepAll}>Keep everything</button>
        {hasForeign && <button onClick={keepPreferred}>Keep English only</button>}
        <button onClick={keepPrimaryOnly}>Keep one audio track</button>
        {isSelected && selectedCount > 1 && (
          <button className="apply" onClick={() => onApplyToSelection(selection)}>
            Apply to {selectedCount - 1} other selected
          </button>
        )}
      </div>
    </div>
  );
}

function AudioRow({
  track, checked, isPrimary, onToggle,
}: {
  track: AudioTrack;
  checked: boolean;
  isPrimary: boolean;
  onToggle: () => void;
}) {
  const willReencode = isPrimary && AUDIO_REPLACE.has(track.codec.toLowerCase());
  return (
    <label className={`track${checked ? "" : " off"}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ accentColor: "var(--amber)" }} />
      <span className="tno">#{track.index}</span>
      <span className="tcodec">{track.codec.toUpperCase()}</span>
      <span className="tlang">{track.language ?? "untagged"}</span>
      <span className="tmeta">
        {track.channelLayout ?? `${track.channels}ch`}
        {track.bitrate ? ` · ${Math.round(track.bitrate / 1000)}k` : ""}
        {track.title ? ` · ${track.title}` : ""}
      </span>
      {track.hasAtmos && <span className="tflag atmos">Atmos</span>}
      {track.isDefault && <span className="tflag">default</span>}
      {isPrimary && <span className="tflag primary">{willReencode ? "→ AC3 640k" : "primary"}</span>}
    </label>
  );
}

function SubRow({ track, checked, onToggle }: { track: SubtitleTrack; checked: boolean; onToggle: () => void }) {
  return (
    <label className={`track${checked ? "" : " off"}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ accentColor: "var(--amber)" }} />
      <span className="tno">#{track.index}</span>
      <span className="tcodec">{track.codec.toUpperCase()}</span>
      <span className="tlang">{track.language ?? "untagged"}</span>
      <span className="tmeta">{track.title ?? ""}</span>
      {track.forced && <span className="tflag">forced</span>}
    </label>
  );
}

export { bytes };
