// Presenter notes as blocks to draw: a small Markdown reader for paragraphs, headings, lists, emphasis, code and
// links. Notes are file content, so nothing here makes HTML: the presenter view draws these blocks as React
// elements, and a tag typed in the notes comes out as the text it is.
// shortcut: no nested lists, block quotes, tables or images, and emphasis does not nest; swap in a real Markdown
// renderer if presenter notes need more than talking points
//
// Pure: no React and no DOM, so `pnpm test:excalidraw` runs it in plain Node.

export interface Span {
  type: "text" | "strong" | "em" | "code" | "link";
  text: string;
  /** For a link: where it points. Shown, never followed. */
  href?: string;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "list"; ordered: boolean; items: Span[][] }
  | { type: "code"; text: string };

/** One line's `code`, **strong**, *emphasis* and [links](url); the rest is text. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const mark = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_\s][^_]*)_\b|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let from = 0;
  for (const m of line.matchAll(mark)) {
    if (m.index > from) out.push({ type: "text", text: line.slice(from, m.index) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] ?? m[3]) out.push({ type: "strong", text: m[2] ?? m[3] });
    else if (m[4] ?? m[5]) out.push({ type: "em", text: m[4] ?? m[5] });
    else out.push({ type: "link", text: m[6], href: m[7] });
    from = m.index + m[0].length;
  }
  if (from < line.length) out.push({ type: "text", text: line.slice(from) });
  return out;
}

export function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const end = lines.findIndex((l, at) => at > i && l.startsWith("```"));
      const last = end < 0 ? lines.length : end;
      out.push({ type: "code", text: lines.slice(i + 1, last).join("\n") });
      i = last + 1;
    } else if (heading) {
      out.push({ type: "heading", level: heading[1].length, spans: spans(heading[2]) });
      i++;
    } else if (item) {
      const list: Block = { type: "list", ordered: !item[1], items: [] };
      for (let next: RegExpExecArray | null = item; next && !next[1] === list.ordered; next = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(lines[++i] ?? "")) {
        list.items.push(spans(next[2]));
      }
      out.push(list);
    } else {
      // A paragraph runs to the next empty line or block. Its line breaks stay line breaks: notes are read at a glance.
      const start = i;
      while (i < lines.length && lines[i].trim() && (i === start || !/^(#{1,6}\s|```|\s*(?:[-*+]|\d+[.)])\s)/.test(lines[i]))) i++;
      out.push({ type: "paragraph", spans: spans(lines.slice(start, i).join("\n")) });
    }
  }
  return out;
}
