import type { Check } from "./check.ts";

export type JobState = "encoding" | "verifying" | "review" | "replaced" | "failed" | "cancelled";

export interface JobProgress {
  fraction: number | null;
  outTimeSec: number;
  frame: number;
  fps: number;
  speed: number;
  etaSec: number | null;
  outputBytes: number;
}

export interface JobResultView {
  outcome: "replaced" | "review" | "failed" | "cancelled";
  message: string;
  checks: Check[];
  pendingPath: string | null;
  command: string[];
  encoder: string;
  ffmpegVersion: string;
  elapsedSec: number;
  vmaf: number | null;
}

export interface JobStage {
  label: string;
  step: number;
  steps: number;
  fraction: number | null;
}

export interface Job {
  id: string;
  path: string;
  name: string;
  state: JobState;
  progress: JobProgress | null;
  stage: JobStage | null;
  result: JobResultView | null;
  startedAt: number;
  finishedAt: number | null;
  sourceSize: number;
  message: string;
}
