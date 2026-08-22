export type CheckStatus = "pass" | "fail" | "review" | "skipped";

/** One verification result, shown to the user verbatim. */
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}
