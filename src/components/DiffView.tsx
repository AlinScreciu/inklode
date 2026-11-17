// What differs between two texts, line by line: removed lines, added lines, and the unchanged runs between
// them folded to one row each, which a click opens. The comparison is src/textDiff.ts; the colours are the
// `--diff-*` variables (docs/themes.md). Not tied to a feature: the history panel shows a version of a note
// against its text now with it.

import { useMemo, useState } from "react";
import { fold, lineDiff, type DiffLine } from "../textDiff";

interface Props {
  before: string;
  after: string;
  /** How many unchanged lines stay open next to a change. */
  context?: number;
}

const SIGN = { same: " ", remove: "−", add: "+" };

function Line({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line is-${line.kind}`}>
      <span className="diff-sign" aria-label={line.kind === "same" ? undefined : line.kind === "add" ? "added" : "removed"}>
        {SIGN[line.kind]}
      </span>
      {/* An empty line keeps its height. */}
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

export function DiffView({ before, after, context = 2 }: Props) {
  const rows = useMemo(() => fold(lineDiff(before, after), context), [before, after, context]);
  // The folds that were opened, by the line of `before` each starts at, so they stay open while `after` is typed in.
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  if (before === after) return <p className="diff-empty">The two texts are the same.</p>;
  return (
    <div className="diff" role="group" aria-label="Differences">
      {rows.map((row, i) => {
        if (row.kind !== "fold") return <Line key={i} line={row} />;
        // Folded lines are unchanged ones, which have a line number in both texts.
        const at = (row.lines[0] as { before: number }).before;
        if (open.has(at)) return row.lines.map((line, j) => <Line key={`${i}:${j}`} line={line} />);
        return (
          <button key={i} className="diff-fold" onClick={() => setOpen(new Set([...open, at]))}>
            {row.lines.length} unchanged lines
          </button>
        );
      })}
    </div>
  );
}
