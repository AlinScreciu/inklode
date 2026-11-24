// "Export to PDF" (`note.exportPdf` in App.tsx): the whole note, rendered by components/noteRender.ts, goes into
// `.print-root`, a box under <body> that only print shows (app.css, `@media print`), and the system's print dialog
// opens on it (`printPage`). Its "PDF" menu saves it as a file.

import { call, printPage } from "./core/client";
import { IMAGE_FILE, renderNote, type Html } from "./components/noteRender";

/** The tags and attributes `renderNote` makes; anything else is never put in the page. */
const TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "em", "strong", "del", "code", "pre", "a", "span", "img", "br", "blockquote", "ul", "ol", "li", "input", "hr", "table", "thead", "tbody", "tr", "th", "td"]);
const ATTRS = new Set(["href", "alt", "class", "start", "type", "disabled", "checked", "style", "data-language"]);

/** How long the export waits for the note's images before it prints without the ones still loading. */
const IMAGE_WAIT_MS = 5000;

/** The URL to load a picture of the note from: a web address as it is, a vault file through the asset protocol. */
type Picture = (src: string, embed: boolean) => Promise<string | null>;

/** The elements of `parts`, made with `createElement` and `textContent`: the note's text never becomes markup. */
function build(parts: Html[], pictures: Picture, loading: Promise<void>[]): Node[] {
  return parts.flatMap((part): Node[] => {
    if (typeof part === "string") return [document.createTextNode(part)];
    if (!TAGS.has(part.tag)) return build(part.children ?? [], pictures, loading);
    const node = document.createElement(part.tag);
    for (const [name, value] of Object.entries(part.attrs ?? {})) if (ATTRS.has(name)) node.setAttribute(name, value === true ? "" : value);
    if (node instanceof HTMLImageElement) {
      const src = part.attrs?.src ?? part.attrs?.["data-embed"];
      const embed = part.attrs?.["data-embed"] !== undefined;
      if (typeof src === "string") {
        loading.push(
          pictures(src, embed).then(
            (url) =>
              new Promise<void>((done) => {
                if (!url) return done(node.remove());
                node.onload = () => done();
                // A picture that does not load is left out, not printed as a broken image.
                node.onerror = () => done(node.remove());
                node.src = url;
              }),
            () => node.remove(),
          ),
        );
      }
    }
    node.append(...build(part.children ?? [], pictures, loading));
    return [node];
  });
}

/**
 * Opens the print dialog on the note at `path` with the text `text`. `assetUrl` turns a vault path into a URL the
 * window can load a picture from. Resolves when the dialog is up; the note stays in `.print-root` until the next
 * export, because the dialog draws its preview from the page while it is open.
 */
export async function printNote(path: string, text: string, assetUrl: (path: string) => Promise<string | null>) {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const pictures: Picture = async (src, embed) => {
    if (/^(https?|data):/i.test(src)) return src;
    // `![[name.png]]` is found as a link to it is, anywhere in the vault. `![](path)` is relative to the note.
    const found = embed
      ? (await call<{ path: string | null }>("note.resolve", { link: src, from: path, files: true })).path
      : decodeURIComponent(new URL(src, "file:///" + path.split("/").map(encodeURIComponent).join("/")).pathname.slice(1));
    return found && IMAGE_FILE.test(found) ? assetUrl(found) : null;
  };
  const loading: Promise<void>[] = [];
  const root = document.createElement("article");
  root.className = "print-root";
  root.append(...build(renderNote(text, name), pictures, loading));
  document.querySelector(".print-root")?.remove();
  document.body.append(root);
  await Promise.race([Promise.all(loading), new Promise((done) => setTimeout(done, IMAGE_WAIT_MS))]);
  // The name the dialog's "Save as PDF" offers.
  const title = document.title;
  document.title = name;
  try {
    await printPage();
  } finally {
    // The dialog has taken the name by the time the shell answers.
    setTimeout(() => (document.title = title), 1000);
  }
}
