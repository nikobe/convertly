import { splitFileName } from "../shared/filename.ts";

/** A filename that truncates in the middle, keeping the distinguishing tail. */
export function FileName({ name, tailLength = 16 }: { name: string; tailLength?: number }) {
  const { head, tail } = splitFileName(name, tailLength);
  return (
    <span className="fname">
      <span className="fhead">{head}</span>
      {tail && <span className="ftail">{tail}</span>}
    </span>
  );
}
