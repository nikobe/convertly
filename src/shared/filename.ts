/**
 * Split a filename so the tail is never truncated.
 *
 * Files in one folder almost always differ at the end — a "copy" suffix, a
 * quality tag, the extension — so cutting the end off hides exactly the part
 * that tells them apart. Callers render the head with a CSS ellipsis and pin
 * the tail.
 */
export function splitFileName(name: string, tailLength = 16): { head: string; tail: string } {
  if (name.length <= tailLength + 8) return { head: name, tail: "" };

  const target = name.length - tailLength;
  const from = Math.max(0, target - 8);
  const window = name.slice(from, Math.min(name.length, target + 8));

  // Prefer a natural boundary near the target so the tail reads as a unit.
  let split = target;
  for (const separator of [" - ", " ", ".", "_"]) {
    const found = window.lastIndexOf(separator);
    if (found > 0) {
      split = from + found;
      break;
    }
  }

  return {
    head: name.slice(0, split),
    // Leading whitespace renders as a gap after the ellipsis, which reads as a
    // column break rather than a truncation.
    tail: name.slice(split).replace(/^\s+/, ""),
  };
}
