// A comparison of two texts with room to read it: a header that says what is compared, how many lines
// were added and removed, and the buttons for what can be done about it, over the DiffView, which scrolls.
// It fills the pane it is in. The review module shows a changed note with it, and the history module the
// picked version when its comparison is set to open in a pane.

import type { ReactNode } from "react";
import { lineDiff } from "../textDiff";
import { DiffView } from "./DiffView";

interface Props {
  title: string;
  /** Under the title: what the note is compared with. */
  detail?: string;
  /** The older text. Null: there is nothing to compare yet, and `empty` says why. */
  before: string | null;
  after: string;
  /** Shown in place of the comparison while `before` is null. */
  empty?: string;
  /** The buttons at the header's right. */
  children?: ReactNode;
}

/** How many lines `after` has more and fewer than `before`, as the DiffView marks them. */
export function diffCounts(before: string, after: string): { added: number; removed: number } {
  const lines = lineDiff(before, after);
  const count = (kind: string) => lines.filter((line) => line.kind === kind).length;
  return { added: count("add"), removed: count("remove") };
}

export function DiffPane({ title, detail, before, after, empty, children }: Props) {
  const counts = before === null ? null : diffCounts(before, after);
  return (
    <section className="diff-pane" aria-label={title}>
      <header className="diff-pane-head">
        <div className="diff-pane-names">
          <span className="diff-pane-title">{title}</span>
          {detail && <span className="diff-pane-detail">{detail}</span>}
        </div>
        {counts && (
          <span className="diff-pane-counts" aria-label={`${counts.added} lines added, ${counts.removed} removed`}>
            <span className="diff-count is-add">+{counts.added}</span>
            <span className="diff-count is-remove">−{counts.removed}</span>
          </span>
        )}
        <div className="diff-pane-actions">{children}</div>
      </header>
      <div className="diff-pane-body">{before === null ? <p className="diff-empty">{empty}</p> : <DiffView before={before} after={after} context={3} />}</div>
    </section>
  );
}
