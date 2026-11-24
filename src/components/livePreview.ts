// Live Preview: the same document as source mode, with decorations that hide
// Markdown markup and style the content. The markup of an element shows again
// while the cursor or selection touches it (for line-level marks: its line), in
// the editor that has the focus, once the cursor was put somewhere in it.
// Decorations never change the text, so nothing here can alter the file.
//
// The `md-*` class names are styled in app.css and are what themes target.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, type Line, MapMode, type Range, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { GFM, type MarkdownConfig, type MarkdownExtension } from "@lezer/markdown";
import { commands } from "../commands";
import { CALLOUT_ICONS, type CalloutHead, type CalloutKind, defaultTitle, FOLD_ICON, isFolded, readCallout } from "./callout";
import { type PropRow, readProps } from "./frontmatter";

/** YAML frontmatter: a `---` line at the very start of the note, up to the next `---` or `...` line. */
const frontmatter: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true, style: tags.meta }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "LinkReference",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        // shortcut: an opening `---` with no closing line makes the rest of the note frontmatter
        // (the parser cannot look ahead); the YAML is not parsed, add @codemirror/lang-yaml to highlight it
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

/** `[[target]]` as a `Wikilink` node and `![[target]]` as an `Embed` node. */
const wikilink: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink", style: tags.link },
    { name: "Embed", style: tags.link },
  ],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        const embed = next === 33; // !
        const open = embed ? pos + 1 : pos;
        if ((!embed && next !== 91) || cx.char(open) !== 91 || cx.char(open + 1) !== 91) return -1; // [[
        const inner = /^[^[\]\n]+\]\]/.exec(cx.slice(open + 2, cx.end));
        if (!inner) return -1;
        return cx.addElement(cx.elt(embed ? "Embed" : "Wikilink", pos, open + 2 + inner[0].length));
      },
    },
  ],
};

/** What Inklode parses on top of CommonMark, in both editor modes: GFM, frontmatter and wikilinks. */
export const markdownSyntax: MarkdownExtension = [GFM, frontmatter, wikilink];

/** True in an editor that is in Live Preview, false in source mode. For extensions that modules add (src/modules.ts). */
export const livePreviewOn = Facet.define<boolean, boolean>({ combine: (values) => values.length > 0 });

/**
 * True in the reading view: Live Preview's decorations in an editor that cannot be edited (Editor.tsx), where the
 * markup never shows, a checkbox is not ticked by a click and the properties block does not open. Links still follow.
 */
export const readingOn = Facet.define<boolean, boolean>({ combine: (values) => values.length > 0 });

/** The URLs to try, in order, for an image written as `src` in the note. */
export type ImageSources = (src: string) => Promise<string[]>;

/**
 * For `![[target]]` that a module draws (src/modules.ts): the function that draws it, or null
 * when no module does. `target` is the link without `#heading` and `|alias`.
 */
export type Embeds = (target: string) => (() => Promise<Element>) | null;

/** Whether a wikilink's target is a note or file in the vault. */
export type Resolves = (target: string) => Promise<boolean>;

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

class Checkbox extends WidgetType {
  /** `offset`: how far the `[` is after the start of the text this widget stands for (2 when it also replaces the `- `). */
  constructor(
    readonly checked: boolean,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: Checkbox) {
    return other.checked === this.checked && other.offset === this.offset;
  }

  toDOM(view: EditorView) {
    // In place of `- [ ] ` the box is as wide as a bullet, so task text lines up with list text.
    const wrap = document.createElement("span");
    wrap.className = this.offset ? "md-list-marker md-task" : "md-task";
    const box = wrap.appendChild(document.createElement("input"));
    box.type = "checkbox";
    box.className = "md-task-checkbox";
    box.checked = this.checked;
    // Keeps the cursor and the focus where they are.
    box.onmousedown = (event) => event.preventDefault();
    box.onclick = (event) => {
      // The box shows what the document says, so the tick comes from the edit, not from the click.
      event.preventDefault();
      // shortcut: a box in the reading view does not tick, as nothing there edits the note; let it tick (Obsidian's reading view does) if that is missed
      if (view.state.readOnly) return;
      const marker = view.posAtDOM(wrap) + this.offset;
      if (view.state.sliceDoc(marker, marker + 1) !== "[") return;
      view.dispatch({ changes: { from: marker + 1, to: marker + 2, insert: this.checked ? " " : "x" } });
    };
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const icon = (shapes: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
// Lucide's "copy" and "check" (lucide-react draws the app's other icons; a widget is plain DOM).
const COPY_ICON = icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
const COPIED_ICON = icon('<path d="M20 6 9 17l-5-5"/>');

/** The corner of a fenced code block while its ``` lines are hidden: the language's name and a Copy button. */
class CodeTools extends WidgetType {
  constructor(
    readonly name: string,
    readonly code: string,
  ) {
    super();
  }

  eq(other: CodeTools) {
    return other.name === this.name && other.code === this.code;
  }

  toDOM() {
    const tools = document.createElement("span");
    tools.className = "md-codeblock-tools";
    if (this.name) {
      const label = tools.appendChild(document.createElement("span"));
      label.className = "md-codeblock-lang";
      label.textContent = this.name;
    }
    const copy = tools.appendChild(document.createElement("button"));
    copy.className = "md-codeblock-copy";
    copy.type = "button";
    copy.title = copy.ariaLabel = "Copy the code";
    copy.innerHTML = COPY_ICON;
    // The press must not move the cursor into the block, which would show its ``` lines and remove this button.
    copy.onmousedown = (event) => event.preventDefault();
    copy.onclick = () => {
      void navigator.clipboard.writeText(this.code).then(() => {
        copy.innerHTML = COPIED_ICON;
        copy.classList.add("is-copied");
        setTimeout(() => {
          copy.innerHTML = COPY_ICON;
          copy.classList.remove("is-copied");
        }, 1500);
      });
    };
    return tools;
  }

  ignoreEvent() {
    return true;
  }
}

class Image extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly sources: ImageSources,
  ) {
    super();
  }

  eq(other: Image) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    const img = box.appendChild(document.createElement("img"));
    img.className = "md-image";
    img.alt = this.alt;
    // The line grows when the image arrives, and the editor has to measure it again.
    img.onload = () => view.requestMeasure();
    void this.sources(this.src).then((urls) => {
      const next = () => {
        const url = urls.shift();
        if (url) return (img.src = url);
        // Not loadable: its alt text or path instead. (Browsers draw a broken image each their own way.)
        box.className = "md-image-missing";
        box.textContent = this.alt || this.src;
      };
      img.onerror = next;
      next();
    });
    return box;
  }

  // A click on the image puts the cursor next to it, which shows its markup.
  ignoreEvent() {
    return false;
  }
}

/** A file a module draws in place of its `![[link]]`. A click on it follows the link. */
class Embedded extends WidgetType {
  constructor(
    readonly link: string,
    readonly draw: () => Promise<Element>,
    /** A new number means the file may have changed, and the embed is drawn again. */
    readonly version: number,
  ) {
    super();
  }

  eq(other: Embedded) {
    return other.link === this.link && other.version === this.version;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "md-embed";
    box.dataset.link = this.link;
    this.fill(box, view);
    return box;
  }

  // The same embed in a newer version keeps its element and what it shows until the new drawing is ready.
  updateDOM(box: HTMLElement, view: EditorView) {
    if (box.dataset.link !== this.link) return false;
    this.fill(box, view);
    return true;
  }

  fill(box: HTMLElement, view: EditorView) {
    this.draw()
      .then(
        (drawn) => box.replaceChildren(drawn),
        (e) => box.replaceChildren(`${this.link}: ${e instanceof Error ? e.message : e}`),
      )
      .then(() => view.requestMeasure());
  }

  ignoreEvent() {
    return false;
  }
}

const hidden = Decoration.replace({});
// A list marker with the space after it is a box of a fixed width (`md-list-marker`), so the text of
// every item starts at the same place and wrapped lines can hang under it.
const bullet = Decoration.mark({ class: "md-list-marker md-list-bullet" });
const number = Decoration.mark({ class: "md-list-marker md-list-number" });
/** The spaces before the marker of a nested item. The line's padding indents it instead. */
const listIndent = Decoration.mark({ class: "md-list-indent" });
const inlineCode = Decoration.mark({ class: "md-inline-code" });
const lineClass = (name: string, attributes?: Record<string, string>) => Decoration.line({ class: name, attributes });
/** `link` is what `link.follow` gets when the link is clicked: a wikilink's inner text or a URL. */
const linkMark = (kind: string, link: string) =>
  Decoration.mark({ class: `md-link ${kind}`, attributes: { "data-link": link } });

/**
 * Whether the cursor was put somewhere since the note came up in this editor: by a click, a key, typing or a jump
 * to a line. Not by the text changing under it from another pane or from disk. One field for every Live Preview
 * extension, so it keeps its value when the extension is made again (on each change in the vault).
 */
export const cursorPlaced = StateField.define<boolean>({
  create: () => false,
  update: (placed, tr) => placed || tr.selection !== undefined || (tr.docChanged && !tr.annotation(Transaction.remote)),
});

/** The properties block: a row per frontmatter key, the key in one column and its values in the other, lists as pills. */
class Properties extends WidgetType {
  constructor(readonly rows: PropRow[]) {
    super();
  }

  eq(other: Properties) {
    return JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }

  toDOM(view: EditorView) {
    const el = (parent: Element, name: string, text = "") => {
      const child = parent.appendChild(document.createElement(parent.tagName === "DIV" ? "div" : "span"));
      child.className = name;
      child.textContent = text;
      return child;
    };
    const box = document.createElement("div");
    box.className = "md-props";
    for (const row of this.rows) {
      const line = el(box, /^tags?$/i.test(row.key) ? "md-props-row md-props-tags" : "md-props-row");
      line.appendChild(document.createElement("span")).className = "md-props-key";
      line.firstElementChild!.textContent = row.key;
      const values = line.appendChild(document.createElement("span"));
      values.className = row.values.length ? "md-props-values" : "md-props-values is-empty";
      for (const value of row.values) el(values, row.list ? "md-props-pill" : "md-props-value", value);
    }
    // A click puts the cursor into the frontmatter, which then shows as YAML to edit. Done here because
    // the block can stand under the title, where a click would put the cursor in the title's line.
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (view.state.facet(readingOn)) return;
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
      view.focus();
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

/** The name of the note in the editor, without `.md`. Given by the editor, for `titleLine`. */
export const noteName = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });

/**
 * The line of the level 1 heading that is the note's title: the first text after the frontmatter, when it says the
 * note's name. Null when there is none; the editor then draws the name as the title, so a note has one title, on top.
 */
// shortcut: a setext heading (`===` under the text) is not seen as the title, so such a note shows its name twice; read the syntax tree if that comes up
export function titleLine(state: EditorState): Line | null {
  const { doc } = state;
  let n = 1;
  if (/^---\s*$/.test(doc.line(1).text)) {
    do n++;
    while (n <= doc.lines && !/^(---|\.\.\.)\s*$/.test(doc.line(n).text));
    n++;
  }
  while (n <= doc.lines && !doc.line(n).text.trim()) n++;
  if (n > doc.lines) return null;
  const heading = /^#\s+(.*?)(?:\s+#+)?\s*$/.exec(doc.line(n).text);
  return heading && heading[1].toLowerCase() === state.facet(noteName).toLowerCase() ? doc.line(n) : null;
}

/**
 * The properties block over a note whose frontmatter is plain keys and values. It stands in place of the YAML
 * until the cursor is put into it (a click on the block does that), and under the title when the note's first
 * heading is its title, so the title is always on top. A field, because only a field may replace whole lines.
 */
const properties = StateField.define<DecorationSet>({
  create: (state) => propertiesOf(state),
  update: (_, tr) => propertiesOf(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

function propertiesOf(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  if (!/^---\s*$/.test(doc.line(1).text)) return Decoration.none;
  const body: string[] = [];
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (/^(---|\.\.\.)\s*$/.test(line.text)) {
      const rows = readProps(body);
      const inside = !state.facet(readingOn) && state.field(cursorPlaced) && selection.ranges.some((r) => r.from <= line.to);
      if (!rows || rows.length === 0 || inside) break;
      // The YAML is hidden and the block is a widget of its own after it, or after the title. As the YAML's
      // replacement it would get the cursor of a note that was just opened drawn beside it, as high as the block.
      return Decoration.set([
        Decoration.replace({ block: true }).range(0, line.to),
        Decoration.widget({ widget: new Properties(rows), block: true, side: 1 }).range((titleLine(state) ?? line).to),
      ]);
    }
    body.push(line.text);
  }
  return Decoration.none;
}

/** The start of a callout's first line, in place of its `> [!type]- `: the type's icon, and its name when there is no title. */
class CalloutTitle extends WidgetType {
  constructor(
    readonly kind: CalloutKind,
    /** Empty when the callout has a title of its own. */
    readonly name: string,
  ) {
    super();
  }

  eq(other: CalloutTitle) {
    return other.kind === this.kind && other.name === this.name;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = "md-callout-head";
    const icon = box.appendChild(document.createElement("span"));
    icon.className = "md-callout-icon";
    icon.innerHTML = CALLOUT_ICONS[this.kind];
    if (this.name) box.appendChild(document.createElement("span")).textContent = this.name;
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

/** The fold mark at the end of a foldable callout's first line. */
class CalloutFold extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }

  eq(other: CalloutFold) {
    return other.folded === this.folded;
  }

  toDOM() {
    const mark = document.createElement("span");
    mark.className = this.folded ? "md-callout-fold is-folded" : "md-callout-fold";
    mark.innerHTML = FOLD_ICON;
    return mark;
  }

  ignoreEvent() {
    return false;
  }
}

/** Folds or opens the callout whose first line starts here. Only the view changes, never the text. */
const flipCallout = StateEffect.define<number>({ map: (pos, change) => change.mapPos(pos, -1) });

/**
 * The first lines (their start) of the callouts that were clicked open or shut, against what their `-` or `+`
 * says. Kept through edits; a line that is deleted drops out. One field for every Live Preview extension, like
 * `cursorPlaced`, so a fold stays when the extension is made again.
 */
const calloutFlips = StateField.define<readonly number[]>({
  create: () => [],
  update(flips, tr) {
    let next = tr.docChanged
      ? flips.map((pos) => tr.changes.mapPos(pos, -1, MapMode.TrackDel)).filter((pos): pos is number => pos !== null)
      : flips;
    for (const effect of tr.effects) {
      if (effect.is(flipCallout)) next = next.includes(effect.value) ? next.filter((pos) => pos !== effect.value) : [...next, effect.value];
    }
    return next;
  },
});

/** The callout of a quote that starts at `from` (its first `>`), with its first line and whether it shows folded. Null for a plain quote. */
function calloutAt(state: EditorState, from: number): { head: CalloutHead; line: Line; folded: boolean } | null {
  const line = state.doc.lineAt(from);
  const head = readCallout(state.sliceDoc(from, line.to));
  return head && { head, line, folded: isFolded(head, state.field(calloutFlips, false)?.includes(line.from) ?? false) };
}

/** Whether a quote is inside a callout. Such a callout is drawn as a plain quote inside the outer one. */
const inCallout = (state: EditorState, node: ReturnType<typeof syntaxTree>["topNode"]) => {
  for (let up = node.parent; up; up = up.parent) if (up.name === "Blockquote" && calloutAt(state, up.from)) return true;
  return false;
};

const foldedBody = Decoration.replace({});

/**
 * The lines under the first line of each folded callout, hidden. A field, because only a field may hide line breaks.
 * Whether the cursor is in the callout does not matter: a fold is opened with a click on the title, or by
 * deleting its `-`.
 */
// shortcut: reads the note's whole syntax tree on each edit, fast for notes of a few thousand lines; look only at the changed range if that lags
const calloutFolds = StateField.define<DecorationSet>({
  create: foldsOf,
  update: (folds, tr) =>
    tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state) || tr.effects.some((e) => e.is(flipCallout)) ? foldsOf(tr.state) : folds,
  provide: (field) => EditorView.decorations.from(field),
});

function foldsOf(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Blockquote") {
        const callout = calloutAt(state, node.from);
        const end = state.doc.lineAt(node.to).to;
        if (callout?.folded && end > callout.line.to) out.push(foldedBody.range(callout.line.to, end));
        return false;
      }
      // Quotes are at the top of the note or in lists. Nothing else holds one.
      return node.name === "Document" || node.name === "BulletList" || node.name === "OrderedList" || node.name === "ListItem";
    },
  });
  return Decoration.set(out);
}

/** Whether the editor's text is what has the focus in the window. Unlike `view.hasFocus`, also while another app is in front. */
const focused = (view: EditorView) => view.root.activeElement === view.contentDOM;

function build(
  view: EditorView,
  sources: ImageSources,
  embeds: Embeds,
  version: number,
  /** False for a wikilink whose target is known not to exist. */
  exists: (link: string) => boolean,
): DecorationSet {
  const { doc, selection } = view.state;
  const out: Range<Decoration>[] = [];
  const text = (from: number, to: number) => doc.sliceString(from, to);
  // The one rule for showing markup as written: only in the editor that has the focus, and only once the cursor
  // was put somewhere in it. A note that was just opened, or that sits in another pane, shows everything rendered.
  const reveal = !view.state.facet(readingOn) && view.state.field(cursorPlaced) && focused(view);
  /** Whether the cursor or a selection is in or at the edge of this range, in an editor that shows markup there. */
  const touched = (from: number, to: number) => reveal && selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return touched(line.from, line.to);
  };
  // A plugin's decorations may not hide a line break, so a range that spans lines stays visible.
  const hide = (from: number, to: number) => {
    if (from < to && doc.lineAt(from).to >= to) out.push(hidden.range(from, to));
  };
  /** The `>` of each callout's first line that the callout's title stands in place of, and the callouts shown as written. */
  const calloutMarks = new Set<number>();
  const rawCallouts: { from: number; to: number }[] = [];
  const calloutsDrawn = new Set<number>();
  const image = (from: number, to: number, src: string, alt: string) => {
    out.push(Decoration.widget({ widget: new Image(src, alt, sources), side: 1 }).range(to));
    if (!touched(from, to)) hide(from, to);
  };

  for (const visible of view.visibleRanges) {
    /** Adds a class to every visible line of a block. */
    const lines = (from: number, to: number, name: string, attributes?: Record<string, string>) => {
      const end = Math.min(to, visible.to);
      for (let pos = Math.max(from, visible.from); pos <= end; ) {
        const line = doc.lineAt(pos);
        out.push(lineClass(name, attributes).range(line.from));
        pos = line.to + 1;
      }
    };

    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(ref) {
        const { name, from, to } = ref;
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) return lines(from, to, `md-heading md-heading-${heading[1]}`);

        switch (name) {
          case "Frontmatter": {
            // Plain keys and values are the properties block (the `properties` field) until the cursor is in them.
            if (view.state.field(properties).size) return false;
            const last = doc.lineAt(to);
            const body: string[] = [];
            for (let n = 2; n < last.number; n++) body.push(doc.line(n).text);
            // YAML that is not plain keys and values keeps its raw look; with the cursor in it, any is shown as written.
            return lines(from, to, touched(from, to) || readProps(body) ? "md-frontmatter-source" : "md-frontmatter"), false;
          }

          case "HeaderMark": {
            // Only the `#` of an ATX heading. The `===` under a setext heading stays.
            if (text(from, from + 1) !== "#" || lineTouched(from)) return;
            const space = /^[ \t]*/.exec(text(to, doc.lineAt(to).to))![0].length;
            return hide(from, to + space);
          }

          case "EmphasisMark":
          case "StrikethroughMark": {
            const parent = ref.node.parent!;
            if (!touched(parent.from, parent.to)) hide(from, to);
            return;
          }

          case "InlineCode": {
            out.push(inlineCode.range(from, to));
            if (!touched(from, to)) for (const mark of ref.node.getChildren("CodeMark")) hide(mark.from, mark.to);
            return false;
          }

          case "Wikilink":
          case "Embed": {
            const open = name === "Embed" ? 3 : 2;
            const inner = text(from + open, to - 2);
            const bar = inner.indexOf("|");
            // shortcut: `![[note]]` shows as a link, not as the note's content; render it when transclusion is wanted
            if (name === "Embed" && IMAGE_FILE.test(inner.split("|")[0].trim())) {
              image(from, to, inner.split("|")[0].trim(), bar < 0 ? "" : inner.slice(bar + 1));
              return false;
            }
            const draw = name === "Embed" ? embeds(inner.split(/[#|]/)[0].trim()) : null;
            if (draw) {
              out.push(Decoration.widget({ widget: new Embedded(inner, draw, version), side: 1 }).range(to));
              if (!touched(from, to)) hide(from, to);
              return false;
            }
            if (touched(from, to)) return false;
            // `[[target|alias]]` shows the alias, `[[target#heading]]` shows as written.
            const shown = from + open + bar + 1;
            hide(from, shown);
            hide(to - 2, to);
            if (shown < to - 2) out.push(linkMark(exists(inner) ? "md-wikilink" : "md-wikilink is-unresolved", inner).range(shown, to - 2));
            return false;
          }

          case "Link": {
            const marks = ref.node.getChildren("LinkMark");
            const url = ref.node.getChild("URL");
            // `[text][ref]` and `[text]` have no URL of their own and stay as written.
            if (!url || marks.length < 2 || touched(from, to)) return;
            hide(from, marks[0].to);
            hide(marks[1].from, to);
            if (marks[0].to < marks[1].from) {
              out.push(linkMark("md-external-link", text(url.from, url.to)).range(marks[0].to, marks[1].from));
            }
            return;
          }

          case "URL": {
            // A bare or `<...>` URL in the text. Those inside `[text](url)` are handled with their link.
            const href = text(from, to);
            if (/^https?:/i.test(href)) out.push(linkMark("md-external-link", href).range(from, to));
            return;
          }

          case "Image": {
            const marks = ref.node.getChildren("LinkMark");
            const url = ref.node.getChild("URL");
            if (url && marks.length >= 2) image(from, to, text(url.from, url.to), text(marks[0].to, marks[1].from));
            return false;
          }

          case "ListItem": {
            let depth = 1;
            for (let up = ref.node.parent; up; up = up.parent) if (up.name === "ListItem") depth++;
            const marker = ref.node.getChild("Task")?.getChild("TaskMarker");
            const done = marker && text(marker.from + 1, marker.from + 2) !== " ";
            // The item's own lines. The lines of a list inside it belong to that list's items.
            // shortcut: a paragraph of the item that comes after its nested list is not indented with it;
            // class every line of the item that is not in a nested item when notes use that
            const nested = ref.node.getChild("BulletList") ?? ref.node.getChild("OrderedList");
            const end = nested ? doc.lineAt(nested.from).from - 1 : to;
            lines(from, Math.max(from, end), `md-list-line${depth % 2 ? "" : " md-list-even"}${done ? " md-task-done" : ""}`, { style: `--list-depth: ${depth}` });
            const start = doc.lineAt(from).from;
            if (start < from) out.push(listIndent.range(start, from));
            return;
          }

          case "ListMark": {
            const marker = ref.node.parent?.getChild("Task")?.getChild("TaskMarker");
            const dash = /^[-*+]$/.test(text(from, to));
            const space = (pos: number) => pos + (text(pos, pos + 1) === " " ? 1 : 0);
            // `- [ ]` becomes a checkbox. `1. [ ]` keeps its number.
            if (marker && dash && !touched(from, marker.to)) {
              const checked = text(marker.from + 1, marker.from + 2) !== " ";
              out.push(Decoration.replace({ widget: new Checkbox(checked, marker.from - from) }).range(from, space(marker.to)));
              return;
            }
            out.push((dash ? bullet : number).range(from, space(to)));
            if (marker && !touched(from, marker.to)) {
              const checked = text(marker.from + 1, marker.from + 2) !== " ";
              out.push(Decoration.replace({ widget: new Checkbox(checked, 0) }).range(marker.from, marker.to));
            }
            return;
          }

          case "Blockquote": {
            // shortcut: a callout inside a callout is drawn as a plain quote in the outer one; give it a box of its own when nested callouts are wanted
            const callout = inCallout(view.state, ref.node) ? null : calloutAt(view.state, from);
            if (!callout) return lines(from, to, "md-blockquote");
            // A callout: a box in its type's colour, its first line the title. With the cursor in it, all of its
            // markup shows; the box and a fold stay.
            const { head, line, folded } = callout;
            const raw = touched(from, to);
            const foldable = head.fold ? " is-foldable" : "";
            lines(from, to, `md-callout md-callout-${head.kind}`, { "data-callout": head.type });
            // A fold splits the visible ranges, so the same callout comes up again in the range after it.
            if (calloutsDrawn.has(from)) return;
            calloutsDrawn.add(from);
            out.push(lineClass(`md-callout-title${foldable}${folded ? " is-folded" : ""}${raw ? " is-raw" : ""}`).range(line.from));
            out.push(lineClass("md-callout-end").range(folded ? line.from : doc.lineAt(to).from));
            if (raw) {
              rawCallouts.push({ from, to });
              return;
            }
            calloutMarks.add(from);
            out.push(Decoration.replace({ widget: new CalloutTitle(head.kind, head.title ? "" : defaultTitle(head.type)) }).range(from, from + head.titleAt));
            // Before the end of the line: a folded body is hidden from there on, and the mark must stay out of it.
            if (head.fold) out.push(Decoration.widget({ widget: new CalloutFold(folded), side: -1 }).range(line.to));
            return;
          }

          case "QuoteMark":
            if (calloutMarks.has(from) || rawCallouts.some((c) => c.from <= from && from <= c.to)) return;
            if (!lineTouched(from)) hide(from, to + (text(to, to + 1) === " " ? 1 : 0));
            return;

          case "HorizontalRule":
            if (!lineTouched(from)) lines(from, to, "md-hr");
            return;

          case "FencedCode": {
            lines(from, to, "md-codeblock");
            const first = doc.lineAt(from);
            out.push(lineClass("md-codeblock-begin").range(first.from), lineClass("md-codeblock-end").range(doc.lineAt(to).from));
            // With the cursor outside the block its ``` lines are hidden and shrink to the block's top and
            // bottom padding, and the language is a label in the corner.
            const open = touched(from, to);
            for (const mark of ref.node.getChildren("CodeMark")) {
              const line = doc.lineAt(mark.from);
              out.push(lineClass(open ? "md-codeblock-fence" : "md-codeblock-fence is-collapsed").range(line.from));
              if (!open) hide(line.from, line.to);
            }
            if (!open) {
              const info = ref.node.getChild("CodeInfo");
              // The code is the lines between the two ``` lines; a block that is not closed runs to its end.
              const last = doc.lineAt(to);
              const closed = last.number > first.number && ref.node.getChildren("CodeMark").length > 1;
              const code = last.number > first.number + (closed ? 1 : 0) ? text(first.to + 1, closed ? last.from - 1 : to) : "";
              out.push(Decoration.widget({ widget: new CodeTools(info ? text(info.from, info.to) : "", code), side: 1 }).range(first.to));
            }
            return false;
          }

          case "CodeBlock":
            lines(from, to, "md-codeblock");
            out.push(lineClass("md-codeblock-begin").range(doc.lineAt(from).from), lineClass("md-codeblock-end").range(doc.lineAt(to).from));
            return false;

          case "Table":
            // The tables module (src/modules/tables) draws a table in place of these lines. With it off,
            // they stay as monospace source so the columns line up.
            lines(from, to, "md-table");
            return false;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

/**
 * The Live Preview extension. `sources` turns an image path in the note into URLs the window can load.
 * `embeds` draws the embeds that modules handle; they are drawn again when `version` is a new number.
 * `resolves` says whether a wikilink leads somewhere; links that do not are shown dimmer.
 */
export function livePreview(sources: ImageSources, embeds: Embeds, version: number, resolves: Resolves) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      // While a mouse button is down, the markup under the cursor is not revealed yet:
      // text that moved under the pointer mid-click would turn a click into a selection.
      held = false;
      stale = false;
      destroyed = false;
      /** Wikilink targets asked about so far: false once the answer was that the target does not exist. */
      known = new Map<string, boolean>();

      constructor(readonly view: EditorView) {
        this.decorations = build(view, sources, embeds, version, this.exists);
        view.dom.ownerDocument.addEventListener("mouseup", this.release);
      }

      // A link counts as there until the answer says otherwise; then the decorations are built again.
      // A change in the vault makes a new `version`, and with it a new plugin that asks again.
      exists = (link: string): boolean => {
        const target = link.split(/[#|]/)[0].trim();
        // `[[#heading]]` is a link inside this note.
        if (!target) return true;
        if (!this.known.has(target)) {
          this.known.set(target, true);
          void resolves(target).then((found) => {
            if (found || this.destroyed) return;
            this.known.set(target, false);
            this.stale = true;
            this.view.dispatch({});
          });
        }
        return this.known.get(target)!;
      };

      update(update: ViewUpdate) {
        const parsed = syntaxTree(update.startState) !== syntaxTree(update.state);
        const flipped = update.transactions.some((tr) => tr.effects.some((e) => e.is(flipCallout)));
        if (update.docChanged || update.viewportChanged || parsed || flipped || (!this.held && (update.selectionSet || this.stale))) {
          this.decorations = build(update.view, sources, embeds, version, this.exists);
          this.stale = false;
        } else if (update.selectionSet) {
          this.stale = true;
        }
      }

      release = () => {
        this.held = false;
        // An empty transaction, only to run `update` again.
        if (this.stale) this.view.dispatch({});
      };

      /** The focus came or went: markup shows only in the editor that has it. After the event, when the editor is not mid-update. */
      refocus() {
        this.stale = true;
        queueMicrotask(() => {
          if (!this.destroyed && !this.held && this.stale) this.view.dispatch({});
        });
      }

      destroy() {
        this.destroyed = true;
        this.view.dom.ownerDocument.removeEventListener("mouseup", this.release);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          // A plain click on a rendered link follows it. With the cursor in the link, its markup
          // shows and a click edits it. Cmd/Ctrl+click is handled in Editor.tsx, in both modes.
          const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
          const link = plain ? (event.target as Element).closest<HTMLElement>("[data-link]") : null;
          if (link) {
            event.preventDefault();
            void commands.run("link.follow", { link: link.dataset.link });
            return true;
          }
          // A click on the title of a foldable callout folds or opens it, unless its markup shows and the click edits it.
          const title = plain ? (event.target as Element).closest<HTMLElement>(".md-callout-title.is-foldable:not(.is-raw)") : null;
          if (title) {
            event.preventDefault();
            this.view.dispatch({ effects: flipCallout.of(this.view.state.doc.lineAt(this.view.posAtDOM(title)).from) });
            return true;
          }
          this.held = true;
          return false;
        },
        focus() {
          this.refocus();
        },
        blur() {
          this.refocus();
        },
      },
    },
  );
  return [cursorPlaced, properties, calloutFlips, calloutFolds, plugin, livePreviewOn.of(true)];
}
