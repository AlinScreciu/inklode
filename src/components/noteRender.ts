// A note's Markdown as a tree of HTML elements, for "Export to PDF" (src/print.ts), where the whole note has to be
// on the page and not only the lines CodeMirror has drawn. Parsed by the same parser and syntax as the editor
// (GFM, frontmatter, wikilinks); frontmatter and HTML comments are left out. Pure: no React and no DOM
// (self-check: noteRender.test.mjs). The tree holds only the tags and attributes made here, and text as text.

import { GFM, parser, type MarkdownConfig } from "@lezer/markdown";

/** An element, or text. `attrs` are the attributes as written; `true` is an attribute without a value. */
export type Html = string | { tag: string; attrs?: Record<string, string | true>; children?: Html[] };

// The frontmatter and wikilink syntax of the editor (`frontmatter` and `wikilink` in livePreview.ts, which
// imports CodeMirror and cannot be loaded here). Keep the two the same.
const frontmatter: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "LinkReference",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
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

const wikilink: MarkdownConfig = {
  defineNodes: [{ name: "Wikilink" }, { name: "Embed" }],
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

const markdown = parser.configure([GFM, frontmatter, wikilink]);

/** A node of the parsed note (`@lezer/common`, which this app does not depend on by name). */
type SyntaxNode = ReturnType<typeof markdown.parse>["topNode"];

/** The marks around content, which do not print: `*`, `` ` ``, `#`, `>`, `-`, `[x]`, a table's `|`, a link's URL. */
const MARKS = new Set(["EmphasisMark", "CodeMark", "LinkMark", "HeaderMark", "QuoteMark", "ListMark", "TaskMarker", "StrikethroughMark", "TableDelimiter", "URL", "LinkTitle", "LinkLabel", "CodeInfo", "Comment", "CommentBlock", "ProcessingInstruction", "ProcessingInstructionBlock", "LinkReference", "Frontmatter"]);

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

/** `&amp;`, `&#38;` and `&#x26;` as the character. One that is not known stays as written. */
function entity(text: string): string {
  const body = text.slice(1, -1);
  const code = /^#x([0-9a-f]+)$/i.exec(body)?.[1];
  const number = code ? parseInt(code, 16) : /^#(\d+)$/.exec(body) ? Number(body.slice(1)) : NaN;
  if (Number.isFinite(number) && number > 0 && number <= 0x10ffff) return String.fromCodePoint(number);
  return ENTITIES[body] ?? text;
}

const el = (tag: string, children: Html[] = [], attrs?: Record<string, string | true>): Html => (attrs ? { tag, attrs, children } : { tag, children });

/** Only these schemes become a link that the PDF keeps; anything else (a note path, `javascript:`) is text. */
const linkable = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

class Renderer {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  slice(from: number, to: number) {
    return this.text.slice(from, to);
  }

  /** The inline content of `node` from `from` to `to`: its text, with what its children stand for in place of them. */
  inline(node: SyntaxNode, from = node.from, to = node.to): Html[] {
    const out: Html[] = [];
    let at = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > at) out.push(this.slice(at, child.from));
      out.push(...this.span(child));
      at = Math.max(at, child.to);
    }
    if (at < to) out.push(this.slice(at, to));
    return out;
  }

  /** One inline node. */
  span(node: SyntaxNode): Html[] {
    const marks = (name: string) => {
      const found: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) found.push(c);
      return found;
    };
    switch (node.name) {
      case "Emphasis":
        return [el("em", this.inline(node))];
      case "StrongEmphasis":
        return [el("strong", this.inline(node))];
      case "Strikethrough":
        return [el("del", this.inline(node))];
      case "InlineCode": {
        const code = marks("CodeMark");
        return [el("code", [this.slice(code[0]?.to ?? node.from, code[code.length - 1]?.from ?? node.to)])];
      }
      case "Link":
      case "Image": {
        const [open, close] = marks("LinkMark");
        const url = node.getChild("URL");
        const href = url ? this.slice(url.from, url.to).replace(/^<|>$/g, "") : "";
        const label = open && close ? this.inline(node, open.to, close.from) : [];
        if (node.name === "Image") return [el("img", [], { src: href, alt: label.filter((x) => typeof x === "string").join("") })];
        return [linkable(href) ? el("a", label, { href }) : el("span", label, { class: "link" })];
      }
      case "Autolink":
      case "URL": {
        const url = this.slice(node.from, node.to).replace(/^<|>$/g, "");
        const href = /^www\./i.test(url) ? "https://" + url : url;
        return [linkable(href) ? el("a", [url], { href }) : url];
      }
      case "Wikilink":
      case "Embed": {
        const inner = this.slice(node.from + (node.name === "Embed" ? 3 : 2), node.to - 2);
        const [target, alias] = inner.split("|");
        if (node.name === "Embed" && IMAGE_FILE.test(target.trim())) return [el("img", [], { "data-embed": target.trim(), alt: alias?.trim() ?? "" })];
        // shortcut: `![[note]]` prints as the note's name, not its content, as Live Preview shows it
        return [el("span", [(alias ?? target).trim()], { class: "link" })];
      }
      case "HardBreak":
        return [el("br")];
      case "Escape":
        return [this.slice(node.from + 1, node.to)];
      case "Entity":
        return [entity(this.slice(node.from, node.to))];
      case "HTMLTag":
        // shortcut: inline HTML is left out but for `<br>`; render it with a sanitiser if notes use it for more
        return /^<br\s*\/?>$/i.test(this.slice(node.from, node.to)) ? [el("br")] : [];
      default:
        return MARKS.has(node.name) ? [] : this.inline(node);
    }
  }

  /** The block children of `node`, each as an element. */
  blocks(node: SyntaxNode): Html[] {
    const out: Html[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) out.push(...this.block(child));
    return out;
  }

  block(node: SyntaxNode): Html[] {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)?.[1];
    if (heading) return [el("h" + heading, trim(this.inline(node)))];
    switch (node.name) {
      case "Paragraph":
        return [el("p", trim(this.inline(node)))];
      case "Blockquote":
        return [el("blockquote", this.blocks(node))];
      case "BulletList":
        return [el("ul", this.blocks(node))];
      case "OrderedList": {
        const first = node.firstChild?.getChild("ListMark");
        const start = first ? parseInt(this.slice(first.from, first.to), 10) : 1;
        return [el("ol", this.blocks(node), start !== 1 && Number.isFinite(start) ? { start: String(start) } : undefined)];
      }
      case "ListItem": {
        const task = node.getChild("Task");
        if (!task) return [el("li", this.blocks(node))];
        const marker = task.getChild("TaskMarker");
        const done = marker !== null && this.slice(marker.from + 1, marker.to - 1).trim() !== "";
        const box = el("input", [], done ? { type: "checkbox", disabled: true, checked: true } : { type: "checkbox", disabled: true });
        // The item's other blocks: a nested list, more paragraphs. The task's own line is `Task`, which `block` skips.
        const rest = this.blocks(node);
        return [el("li", [el("p", [box, " ", ...trim(this.inline(task, marker?.to ?? task.from))]), ...rest], { class: done ? "print-task is-done" : "print-task" })];
      }
      case "Task":
        return [];
      case "FencedCode":
      case "CodeBlock": {
        const code = node.getChild("CodeText");
        const info = node.getChild("CodeInfo");
        const language = info ? this.slice(info.from, info.to).trim().split(/\s/)[0] : "";
        // shortcut: code inside a quote or a list keeps the `>` and the indent of its lines, and is not
        // coloured; strip them by the quote's and the item's columns if such code is printed often
        return [el("pre", [el("code", [code ? this.slice(code.from, code.to) : ""])], language ? { "data-language": language } : undefined)];
      }
      case "HorizontalRule":
        return [el("hr")];
      case "Table":
        return [this.table(node)];
      case "HTMLBlock":
        // The raw HTML as text: a reader sees that something is there.
        return [el("pre", [el("code", [this.slice(node.from, node.to)])], { class: "html" })];
      default:
        if (MARKS.has(node.name)) return [];
        return node.firstChild ? this.blocks(node) : [el("p", [this.slice(node.from, node.to)])];
    }
  }

  table(node: SyntaxNode): Html {
    const delimiter = node.getChildren("TableDelimiter")[0];
    const aligns = delimiter
      ? this.slice(delimiter.from, delimiter.to)
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => {
            const c = cell.trim();
            return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null;
          })
      : [];
    const row = (r: SyntaxNode, tag: "th" | "td") =>
      el(
        "tr",
        r.getChildren("TableCell").map((cell, i) => el(tag, trim(this.inline(cell)), aligns[i] ? { style: `text-align: ${aligns[i]}` } : undefined)),
      );
    const header = node.getChild("TableHeader");
    return el("table", [
      ...(header ? [el("thead", [row(header, "th")])] : []),
      el(
        "tbody",
        node.getChildren("TableRow").map((r) => row(r, "td")),
      ),
    ]);
  }
}

/** Without the spaces at the start of the first piece of text and the end of the last. */
function trim(parts: Html[]): Html[] {
  const out = [...parts];
  if (typeof out[0] === "string") out[0] = out[0].trimStart();
  const last = out.length - 1;
  if (typeof out[last] === "string") out[last] = (out[last] as string).trimEnd();
  return out.filter((part) => part !== "");
}

/** The text of an element tree, for comparing a heading with the note's name. */
export function textOf(parts: Html[]): string {
  return parts.map((part) => (typeof part === "string" ? part : textOf(part.children ?? []))).join("");
}

/**
 * The note `text` as elements, under its name `name` as a title, the way Live Preview shows it: no title when
 * the note starts with a level 1 heading that says the name already.
 */
export function renderNote(text: string, name: string): Html[] {
  const doc = markdown.parse(text).topNode;
  const blocks = new Renderer(text).blocks(doc);
  const first = blocks[0];
  const titled = typeof first !== "string" && first?.tag === "h1" && textOf(first.children ?? []).trim().toLowerCase() === name.trim().toLowerCase();
  return titled ? blocks : [el("h1", [name], { class: "print-title" }), ...blocks];
}
