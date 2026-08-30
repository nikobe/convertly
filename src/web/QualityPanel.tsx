import { useState } from "react";
import type { Preset } from "../shared/preset.ts";

/**
 * Quality controls, in the terms the decision is actually made in.
 *
 * CRF is the real knob but "20" means nothing on its own, so each step is
 * labelled by what it does to the picture and the file.
 */
const QUALITY_STEPS: { crf: number; label: string; note: string }[] = [
  { crf: 16, label: "Archival", note: "Visually identical to the source. Barely smaller — rarely worth it." },
  { crf: 18, label: "Near-lossless", note: "No visible difference on any normal viewing. Larger files." },
  { crf: 20, label: "Same quality", note: "The default. Indistinguishable in motion, roughly half the size." },
  { crf: 22, label: "Very good", note: "A trained eye on a still frame might spot it. Noticeably smaller." },
  { crf: 24, label: "Good", note: "Visible on grain and dark scenes. Much smaller." },
  { crf: 26, label: "Small", note: "Softer, and grain starts to smear. For things you will not rewatch." },
];

const SPEEDS: { value: Preset["x265Preset"]; label: string; note: string }[] = [
  { value: "veryfast", label: "Very fast", note: "~4× quicker than medium, and needs ~20% more bitrate for the same look." },
  { value: "fast", label: "Fast", note: "About twice the speed of medium for a few percent more bitrate." },
  { value: "medium", label: "Medium", note: "The default. The best balance on this hardware." },
  { value: "slow", label: "Slow", note: "About half the speed for roughly 5% smaller files." },
  { value: "slower", label: "Slower", note: "Two to three times slower again for very little. Rarely worth it." },
];

const AC3_RATES = [
  { value: 640_000, label: "640k" },
  { value: 448_000, label: "448k" },
  { value: 384_000, label: "384k" },
];

const CAPS = [
  { value: null, label: "Never" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
];

export function QualityPanel({
  preset, onChange, onClose, saving, queuedCount, onApplyToQueue,
}: {
  preset: Preset;
  onChange: (next: Preset) => void;
  onClose: () => void;
  saving: boolean;
  queuedCount: number;
  onApplyToQueue: () => void;
}) {
  const [confirmCap, setConfirmCap] = useState(false);
  const step = QUALITY_STEPS.find((s) => s.crf === preset.crf);
  const speed = SPEEDS.find((s) => s.value === preset.x265Preset);

  const setCap = (value: number | null) => {
    // Downscaling is the one setting that cannot be undone by re-encoding, so
    // it asks once rather than sitting quietly in a corner.
    if (value !== null && !confirmCap) {
      setConfirmCap(true);
      return;
    }
    setConfirmCap(false);
    onChange({ ...preset, maxHeight: value });
  };

  return (
    <section className="quality" aria-label="Quality settings">
      <div className="qhead">
        <h2>Quality</h2>
        <span className="qsub">
          Applies to every encode from here on{saving ? " · saving" : " · saved"}
        </span>
        <span className="spacer" />
        <button className="jbtn" onClick={onClose}>Close</button>
      </div>

      <div className="qgrid">
        <div className="qfield">
          <label htmlFor="q-crf">Picture quality</label>
          <div className="qsteps" role="group" aria-labelledby="q-crf">
            {QUALITY_STEPS.map((s) => (
              <button
                key={s.crf}
                className={`qstep${preset.crf === s.crf ? " on" : ""}`}
                onClick={() => onChange({ ...preset, crf: s.crf })}
                aria-pressed={preset.crf === s.crf}
                title={s.note}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="qnote">{step?.note ?? `CRF ${preset.crf}.`} <span className="qcrf">CRF {preset.crf}</span></p>
        </div>

        <div className="qfield">
          <label htmlFor="q-speed">Encoder speed</label>
          <select
            id="q-speed"
            value={preset.x265Preset}
            onChange={(e) => onChange({ ...preset, x265Preset: e.target.value as Preset["x265Preset"] })}
          >
            {SPEEDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <p className="qnote">{speed?.note}</p>
        </div>

        <div className="qfield">
          <label htmlFor="q-cap">Downscale</label>
          <div className="qsteps" role="group">
            {CAPS.map((c) => (
              <button
                key={String(c.value)}
                className={`qstep${preset.maxHeight === c.value ? " on" : ""}${c.value ? " danger" : ""}`}
                onClick={() => setCap(c.value)}
                aria-pressed={preset.maxHeight === c.value}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="qnote">
            {confirmCap
              ? <span className="qwarn">Resolution is the one thing a re-encode cannot give back. Click again to confirm.</span>
              : preset.maxHeight
                ? <span className="qwarn">Capping at {preset.maxHeight}p — anything taller is permanently downscaled.</span>
                : "Resolution is left alone. 4K stays 4K."}
          </p>
        </div>

        <div className="qfield">
          <label htmlFor="q-ac3">Replacement audio</label>
          <select
            id="q-ac3"
            value={preset.ac3Bitrate}
            onChange={(e) => onChange({ ...preset, ac3Bitrate: Number(e.target.value) })}
          >
            {AC3_RATES.map((r) => <option key={r.value} value={r.value}>AC3 {r.label}</option>)}
          </select>
          <p className="qnote">
            Only applies to tracks that get re-encoded — DTS, lossless, or wider than 5.1.
            Stereo is scaled down from this and never upmixed.
          </p>
        </div>

        <div className="qfield">
          <label>
            <input
              type="checkbox"
              checked={preset.tenBit}
              onChange={(e) => onChange({ ...preset, tenBit: e.target.checked })}
              style={{ accentColor: "var(--amber)" }}
            />{" "}
            10-bit output
          </label>
          <p className="qnote">
            Free on the hardware path and removes banding on gradients. Leave it on unless a player complains.
          </p>
        </div>
      </div>

      <div className="qactions">
        {queuedCount > 0 && (
          <button className="jbtn go" onClick={onApplyToQueue}>
            Also apply to {queuedCount} waiting
          </button>
        )}
        <span className="qnote">
          Changes are kept automatically and apply to anything queued from here on. Items
          already waiting keep the settings they were added with, so what you asked for is
          what runs — use the button to change those too.
        </span>
      </div>
    </section>
  );
}
