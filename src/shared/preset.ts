/** An encoding preset. One is marked default and offered on the next encode. */
export interface Preset {
  id: string;
  name: string;
  /** x265 quality. Lower is better quality and a bigger file. */
  crf: number;
  /** x265 speed/efficiency tradeoff. */
  x265Preset: "veryfast" | "fast" | "medium" | "slow" | "slower";
  /** Force an encoder instead of splitting on resolution. Rarely wanted. */
  forceEncoder: "libx265" | "hevc_videotoolbox" | null;
  /** Re-encode incompatible audio to AC3 at this bitrate. */
  ac3Bitrate: number;
  /**
   * What to do with an incompatible primary track.
   *
   * "replace" swaps it for AC3 — the default, and the bigger saving.
   * "add" keeps the original and prepends an AC3 track, which is the only
   * safe treatment for Atmos, since those objects cannot be recovered.
   */
  audioPolicy: "replace" | "add";
  /** Cap output height. Off unless deliberately turned on. */
  maxHeight: number | null;
  /** 10-bit output. Free on the hardware path, better gradients everywhere. */
  tenBit: boolean;
}

export const DEFAULT_PRESET: Preset = {
  id: "default",
  name: "Same quality, smaller",
  crf: 20,
  x265Preset: "medium",
  forceEncoder: null,
  ac3Bitrate: 640_000,
  audioPolicy: "replace",
  maxHeight: null,
  tenBit: true,
};
