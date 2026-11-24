import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Transaction, type StateEffect } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { classHighlighter, tagHighlighter, tags } from "@lezer/highlight";
import { commands } from "../commands";
import { assetUrl, call } from "../core/client";
import { modules, notePath } from "../modules";
import { lineChanges, middle } from "../textDiff";
import { eolOf, toLf, withEol } from "./lineEndings";
import { livePreview, markdownSyntax, noteName, titleLine } from "./livePreview";
import { imageExtension, pastedImageName } from "./pastedImage";

export interface EditorHandle {
  /**
   * Replaces the text with what is now on disk, without reporting it as an edit. With `undoable` the change
   * goes into the undo history, so Undo brings the replaced text back (as an edit, which is then saved).
   */
  setContent(content: string, undoable?: boolean): void;
  /**
   * Puts in the user's text with a change from outside merged into it. Like `setContent` with `undoable`, but
   * only the stretches of lines that differ are replaced, each by itself, so the cursor stays in the line it
   * is in, and Undo takes exactly this back, not the typing before it too.
   */
  merge(content: string): void;
  /** The text now in the editor and the 1-based line the cursor is on. */
  snapshot(): { text: string; line: number } | null;
  focus(): void;
  /** Where the cursor and the scroll are, to give a later editor of the same note as `restore`. */
  position(): EditorPosition | null;
  /** The link under the cursor: the text inside `[[...]]` or a URL. Null with none. */
  link(): string | null;
  /** The note's headings in order, and the index of the one the reader is in (-1 before the first). */
  outline(): { headings: Heading[]; current: number };
  /** Puts the cursor on a line (1-based), scrolls it to the top and takes the focus. */
  reveal(line: number): void;
}

export interface EditorPosition {
  head: number;
  scroll: StateEffect<unknown>;
}

export interface Heading {
  level: number;
  text: string;
  /** 1-based. */
  line: number;
}

interface Props {
  ref?: Ref<EditorHandle>;
  path: string;
  /** The note's text when it was opened. Later edits live in the editor, not in this prop. */
  content: string;
  /** Absolute path of the open vault, for loading images. */
  vaultRoot: string;
  /** Plain Markdown source when true, Live Preview when false. */
  sourceMode: boolean;
  /** Where to put the cursor, 1-based. A new object jumps again, even to the same line. */
  jump?: { line: number };
  /** The cursor and scroll to start at: what `position()` gave when a tab was left. */
  restore?: EditorPosition;
  /** Whether the editor takes the focus when it comes up. */
  autoFocus?: boolean;
  /** A new number when a file in the vault or the set of active modules changed: embeds that modules draw are drawn again. */
  refresh: number;
  onChange(path: string, content: string): void;
  /** Called when the text, the cursor or the scroll position changed, for what follows them (the outline). */
  onMove?(): void;
}

/** Marks a change that put the file's text in place of the user's (`setContent` with `undoable`): not an edit to save. */
const taken = Annotation.define<boolean>();

/** The link that contains `pos`: the text inside `[[...]]`, or the URL of `[text](url)` or of a bare URL. Else null. */
function linkAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  for (const match of line.text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    const from = line.from + match.index;
    if (pos >= from && pos <= from + match[0].length) return match[1];
  }
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent) {
    const url = node.name === "URL" ? node : node.name === "Link" ? node.getChild("URL") : null;
    if (url) return state.sliceDoc(url.from, url.to);
  }
  return null;
}

/** Vault-relative paths an image written as `src` in the note at `notePath` may be at, likeliest first. */
function imagePaths(src: string, notePath: string): string[] {
  // URL resolution handles `../`, a leading `/` (the vault root) and percent-encoding.
  const from = (base: string) =>
    decodeURIComponent(new URL(src, "file:///" + base.split("/").map(encodeURIComponent).join("/")).pathname.slice(1));
  try {
    // shortcut: looks next to the note and at the vault root only, so `![[name.png]]` kept in another
    // folder is not found; add a core call that resolves attachments by name when that is needed
    return [...new Set([from(notePath), from("")])];
  } catch {
    return [];
  }
}

/** Saves a pasted image under a free name (pastedImage.ts) and puts its `![[link]]` over the selection. */
async function pasteImage(view: EditorView, image: File) {
  const ext = imageExtension(image.type)!;
  const data = await new Promise<string>((done, fail) => {
    const reader = new FileReader();
    // A data URL is `data:<type>;base64,<data>`.
    reader.onload = () => done((reader.result as string).slice((reader.result as string).indexOf(",") + 1));
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(image);
  });
  const at = new Date();
  for (let n = 0; ; n++) {
    const name = pastedImageName(at, ext, n);
    try {
      await call("attachment.create", { path: name, data });
    } catch (e) {
      // Taken: the next number. The core's `Exists` reads "already exists: <path>".
      if (n < 100 && /already exists/i.test(String(e))) continue;
      throw e;
    }
    // The editor may be gone (the tab closed) while the file was written; the image is kept.
    if (!view.dom.isConnected) return;
    view.dispatch(view.state.replaceSelection(`![[${name}]]`));
    return;
  }
}

/** The language to colour a fenced code block with, from the name after its ```. Null leaves the code plain. */
/**
 * The language of a code block, from the word after its ```: a language's name or alias (`sh`, `ts`), else a
 * file extension (`py`, `rs`). The language's parser is loaded on first use, each from its own chunk.
 */
function codeLanguage(info: string) {
  const name = info.trim().split(/\s/)[0].toLowerCase();
  return name ? (LanguageDescription.matchLanguageName(languages, name, false) ?? LanguageDescription.matchFilename(languages, `x.${name}`)) : null;
}

/**
 * Markdown editor for one note, in Live Preview or source mode. The parent gives it
 * `key={path}`, so each note gets a fresh editor with its own undo history.
 */
export function Editor({ ref, path, content, vaultRoot, sourceMode, jump, restore, autoFocus, refresh, onChange, onMove }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onMove, autoFocus });
  latest.current = { onChange, onMove, autoFocus };
  // The line ending the note has on disk (lineEndings.ts). The editor's document has "\n" only; every text that
  // leaves the editor (`onChange`, `snapshot`) has this one again, so an edit changes only the lines it touched.
  const eol = useRef(eolOf(content));
  // Holds the Live Preview extension, or nothing in source mode.
  const mode = useRef(new Compartment());
  // Holds the extensions of the modules that are on (`AppApi.editor.registerExtension`).
  const fromModules = useRef(new Compartment());
  // Counts changes between the light and the dark appearance: embeds are drawn in one of the two looks.
  const [look, setLook] = useState(0);
  // In Live Preview every note has its name on top once: its own first heading when that says the name
  // (`titleLine`), and otherwise the name drawn as a title. CSS draws that one from `data-title`, in the
  // content's top padding, so it is not part of the text.
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const title = EditorView.contentAttributes.of((v): Record<string, string> => (titleLine(v.state) ? {} : { "data-title": name }));
  const preview = (version: number) => [
    title,
    noteName.of(name),
    livePreview(
      async (src) => {
        if (/^(https?|data):/i.test(src)) return [src];
        const urls = await Promise.all(imagePaths(src, path).map((p) => assetUrl(vaultRoot, p)));
        return urls.filter((url) => url !== null);
      },
      // An embed a module draws: the file is found the way a link to it is.
      (target) => {
        const render = modules.embedFor(target);
        if (!render) return null;
        return async () => {
          const found = await call<{ path: string | null }>("note.resolve", { link: target, from: path });
          if (!found.path) throw new Error("not found");
          return render(found.path);
        };
      },
      version,
      // A failed lookup leaves the link looking normal.
      (target) => call<{ path: string | null }>("note.resolve", { link: target, from: path, files: true }).then((found) => found.path !== null, () => true),
    ),
  ];

  useEffect(() => {
    const doc = toLf(content);
    const editor = new EditorView({
      parent: host.current!,
      // Not when the note got shorter than where the scroll was.
      scrollTo: restore && (restore.scroll.value as { range: { head: number } }).range.head <= doc.length ? restore.scroll : undefined,
      state: EditorState.create({
        doc,
        selection: restore && { anchor: Math.min(restore.head, doc.length) },
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ extensions: markdownSyntax, codeLanguages: codeLanguage }),
          // classHighlighter adds `tok-*` classes and no colours, so themes style syntax in CSS.
          syntaxHighlighting(classHighlighter),
          // classHighlighter has no class for strikethrough.
          syntaxHighlighting(tagHighlighter([{ tag: tags.strikethrough, class: "tok-strikethrough" }])),
          mode.current.of(sourceMode ? [] : preview(refresh + look)),
          notePath.of(path),
          fromModules.current.of(modules.editorExtension()),
          // Find and replace in this note: the panel sits on top of the pane. `note.find` (App.tsx) opens it too.
          search({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.domEventHandlers({
            // Cmd/Ctrl+click or a middle click on a link: put the cursor there and open it in a new tab. `link.follow`
            // is the app's command (App.tsx); it reads the link from the editor of the pane that was clicked.
            mousedown(event, v) {
              if (!event.metaKey && !event.ctrlKey && event.button !== 1) return false;
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null || !linkAt(v.state, pos)) return false;
              v.dispatch({ selection: { anchor: pos } });
              void commands.run("link.follow", { newTab: true });
              return true;
            },
            // An image on the clipboard (a screenshot, an image copied in a browser) is saved into the vault and
            // linked where the cursor is. Text on the clipboard is left to CodeMirror.
            paste(event, v) {
              const image = [...(event.clipboardData?.files ?? [])].find((file) => imageExtension(file.type));
              if (!image) return false;
              event.preventDefault();
              pasteImage(v, image).catch(commands.onError);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            // A reload from disk (`setContent`) is not an edit and must not be saved back.
            const fromDisk = update.transactions.some((tr) => tr.annotation(Transaction.remote) || tr.annotation(taken));
            if (update.docChanged && !fromDisk) latest.current.onChange(path, withEol(update.state.doc.toString(), eol.current));
            if (update.docChanged || update.selectionSet) latest.current.onMove?.();
          }),
        ],
      }),
    });
    view.current = editor;
    // Only in the active pane: an editor that comes up in another pane must not take the focus from it.
    if (latest.current.autoFocus) editor.focus();
    editor.scrollDOM.addEventListener("scroll", () => latest.current.onMove?.(), { passive: true });
    // The editor is up: what follows it can read it now.
    latest.current.onMove?.();
    const appearance = new MutationObserver(() => setLook((n) => n + 1));
    appearance.observe(document.documentElement, { attributeFilter: ["data-appearance"] });
    return () => {
      appearance.disconnect();
      editor.destroy();
    };
    // Runs once per mounted note: `path`, `content` and `vaultRoot` are fixed for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: [mode.current.reconfigure(sourceMode ? [] : preview(refresh + look)), fromModules.current.reconfigure(modules.editorExtension())],
    });
    // `preview` only uses `path` and `vaultRoot`, which are fixed for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, refresh, look]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !jump) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(jump.line, editor.state.doc.lines)));
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    editor.focus();
  }, [jump]);

  useImperativeHandle(
    ref,
    () => ({
      setContent(content, undoable) {
        const editor = view.current;
        const now = editor?.state.doc.toString();
        if (!editor || now === undefined) return;
        // The file's line ending may be another now.
        eol.current = eolOf(content);
        const next = toLf(content);
        if (now === next) return;
        // Only what differs between the common start and the common end is replaced, so the cursor and the
        // scroll stay where they are while the same note is typed in in another pane.
        // `remote` keeps the change out of the undo history; `taken` only says it is not the user's edit.
        editor.dispatch({ changes: middle(now, next), annotations: undoable ? taken.of(true) : Transaction.remote.of(true) });
      },
      merge(content) {
        const editor = view.current;
        const now = editor?.state.doc.toString();
        if (!editor || now === undefined) return;
        eol.current = eolOf(content);
        const next = toLf(content);
        if (now === next) return;
        editor.dispatch({ changes: lineChanges(now, next), annotations: [taken.of(true), isolateHistory.of("full")] });
      },
      snapshot() {
        const state = view.current?.state;
        return state ? { text: withEol(state.doc.toString(), eol.current), line: state.doc.lineAt(state.selection.main.head).number } : null;
      },
      focus: () => view.current?.focus(),
      position() {
        const editor = view.current;
        return editor ? { head: editor.state.selection.main.head, scroll: editor.scrollSnapshot() } : null;
      },
      link() {
        const state = view.current?.state;
        return state ? linkAt(state, state.selection.main.head) : null;
      },
      outline() {
        const editor = view.current;
        if (!editor) return { headings: [], current: -1 };
        const { state } = editor;
        // From the tree the editor already has, so `#` lines in code and frontmatter are not headings.
        // shortcut: only headings at the top level of the note, not those inside a quote or a list item
        const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
        const headings: (Heading & { from: number })[] = [];
        for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
          const level = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)?.[1];
          if (!level) continue;
          const line = state.doc.lineAt(node.from);
          headings.push({ level: Number(level), text: line.text.replace(/^\s*#+\s*|\s+#+\s*$/g, ""), line: line.number, from: node.from });
        }
        // The reader is where the cursor is, or at the top of what shows once the cursor is scrolled out of sight.
        const box = editor.scrollDOM.getBoundingClientRect();
        const head = state.selection.main.head;
        const at = editor.coordsAtPos(head);
        const seen = at && at.bottom > box.top && at.top < box.bottom;
        const pos = seen ? head : (editor.posAtCoords({ x: box.left + box.width / 2, y: box.top + 8 }, false) ?? head);
        return { headings: headings.map(({ from: _, ...h }) => h), current: headings.filter((h) => h.from <= pos).length - 1 };
      },
      reveal(line) {
        const editor = view.current;
        if (!editor) return;
        const { from } = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines)));
        editor.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 24 }) });
        editor.focus();
      },
    }),
    [],
  );

  return <div className={sourceMode ? "editor is-source" : "editor is-live-preview"} ref={host} />;
}
