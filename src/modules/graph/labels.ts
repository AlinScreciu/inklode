/** A label's place on screen, in px: its box, and how much it matters (the more, the earlier it gets its place). */
export type LabelBox = { left: number; top: number; width: number; height: number; rank: number };

/** Space kept free around a placed label, in px, so two labels never touch. */
const GAP = 2;

/**
 * Which labels to draw so that none covers another: by `rank`, highest first, each one only if its box is
 * free of those already taken. Returns the indices into `boxes`, in the order they were placed.
 */
// shortcut: every label is compared with every placed one, fine for a few thousand notes;
// put the placed boxes in a grid if painting the graph gets slow.
export function placeLabels(boxes: LabelBox[]): number[] {
  const order = boxes.map((_, index) => index).sort((a, b) => boxes[b].rank - boxes[a].rank);
  const placed: number[] = [];
  for (const index of order) {
    const box = boxes[index];
    const taken = placed.some((other) => {
      const o = boxes[other];
      return (
        box.left < o.left + o.width + GAP &&
        o.left < box.left + box.width + GAP &&
        box.top < o.top + o.height + GAP &&
        o.top < box.top + box.height + GAP
      );
    });
    if (!taken) placed.push(index);
  }
  return placed;
}
