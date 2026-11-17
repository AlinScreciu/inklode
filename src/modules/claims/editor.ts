// The claims module's part in the Markdown editor, in Live Preview only: the `<!-- check: … -->` marker at the
// end of a claim line is drawn as one small mark of the claim's status, and the text of a claim that is stale
// or not checked is dimmed. With the cursor on the line the comment shows as written, like other markup.
// A click on the mark opens the claim's popover (popover.ts). Source mode shows the text as typed.
//
// Decorations never change the text, and nothing here runs a check.

import type { Extension, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { cursorPlaced, livePreviewOn } from "../../components/livePreview";
import { notePath } from "../../modules";
import { type Claim, keyOf, locate, marker, type Status } from "./claims";
import { LABEL, markSvg } from "./marks";
import { openPopover } from "./popover";
import { claims, live, state } from "./state";

/** The mark that stands in place of a claim's marker. */
class Mark extends WidgetType {
  constructor(
    readonly claim: Claim,
    readonly checking: boolean,
  ) {
    super();
  }

  eq(other: Mark) {
    return keyOf(other.claim) === keyOf(this.claim) && other.claim.status === this.claim.status && other.claim.evidence === this.claim.evidence && other.checking === this.checking;
  }

  toDOM() {
    const { claim } = this;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = `claim-mark is-${claim.status}${this.checking ? " is-checking" : ""}`;
    mark.dataset.path = claim.path;
    mark.dataset.line = String(claim.line);
    mark.title = `${LABEL[claim.status]}: ${claim.evidence}`;
    mark.setAttribute("aria-label", `Claim ${LABEL[claim.status].toLowerCase()}${this.checking ? ", checking" : ""}. Evidence: ${claim.evidence}`);
    mark.setAttribute("aria-haspopup", "dialog");
    mark.innerHTML = markSvg(claim.status);
    // The editor does not get the press, so the cursor stays where it is and the mark stays drawn.
    mark.addEventListener("mousedown", (event) => event.preventDefault());
    mark.addEventListener("click", () => openPopover(mark, claim));
    return mark;
  }

  ignoreEvent() {
    return true;
  }
}

const DIMMED: Status[] = ["stale", "unchecked"];
const dim = Decoration.mark({ class: "claim-dim" });

function build(view: EditorView): DecorationSet {
  const { state: editor } = view;
  if (!editor.facet(livePreviewOn)) return Decoration.none;
  const path = editor.facet(notePath);
  const listed = claims.get().filter((claim) => claim.path === path);
  if (listed.length === 0) return Decoration.none;
  // The rule of Live Preview for showing markup as written: in the editor that has the focus, once the cursor
  // was put somewhere in it, on the lines the cursor or a selection touches.
  const reveal = editor.field(cursorPlaced, false) === true && view.root.activeElement === view.contentDOM;
  const out: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    for (let pos = visible.from; pos <= visible.to; ) {
      const line = editor.doc.lineAt(pos);
      pos = line.to + 1;
      const found = marker(line.text);
      // Only what the core lists is a claim: a marker in a code block is not.
      const claim = found && locate(listed, path, line.number, found.evidence);
      if (!found || !claim) continue;
      if (DIMMED.includes(claim.status) && found.from > 0) out.push(dim.range(line.from, line.from + found.from));
      if (reveal && editor.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from)) continue;
      const widget = new Mark(claim, state.checking === keyOf(claim));
      out.push(Decoration.replace({ widget }).range(line.from + found.from, line.from + found.to));
    }
  }
  return Decoration.set(out, true);
}

export const extension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** Ends the listening to the list and to the state of the checks. */
    stop: (() => void)[];

    constructor(readonly view: EditorView) {
      this.decorations = build(view);
      // A new list or a check that started or ended: an empty transaction, only to run `update`. Both come
      // from answers of the core, never from inside an update of the editor.
      const redraw = () => this.view.dispatch({});
      this.stop = [claims.subscribe(redraw), live.subscribe(redraw)];
    }

    // Built on every update: it reads only the visible lines, and what it shows depends on the text, the
    // cursor, the focus, the list and the running check.
    update(update: ViewUpdate) {
      this.decorations = build(update.view);
    }

    destroy() {
      this.stop.forEach((end) => end());
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
