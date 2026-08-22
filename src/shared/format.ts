/** Human byte sizes, shared so the server's messages and the UI agree. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  let n = Math.abs(value);
  if (n < 1024) return `${sign}${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${sign}${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
