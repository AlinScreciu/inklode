// What the app reads from a file's name: the extension a rename keeps, and whether the file is a picture or a PDF.
// Pure functions over paths: no React and no DOM (self-check: fileNames.test.mjs).

/**
 * The ending of a file's name that "Rename…" leaves alone: `.excalidraw.md` for a drawing, `.md` for a note,
 * and for any other file its extension (`.png`), or "" when it has none. As the path has it, so `.MD` stays `.MD`.
 */
export function keptExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const note = /(\.excalidraw)?\.md$/i.exec(name);
  if (note) return note[0];
  // A dot at the start of the name is not an extension.
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** Whether the file is a note or a drawing: its name is shown and typed without the extension. */
const isNote = (path: string) => /\.md$/i.test(path);

/** What the rename prompt starts with for the file at `path`: the path without `.md` or `.excalidraw.md`; any other file whole. */
export function renameInitial(path: string): string {
  return isNote(path) ? path.slice(0, path.length - keptExtension(path).length) : path;
}

/**
 * The path a file gets when the user typed `input` as the new name of the file at `from`. The file keeps its
 * kind: a note or a drawing gets its extension back, also when the name was typed with `.md` or
 * `.excalidraw.md`. Any other file is named as typed, and gets its extension back only when the typed name
 * has none, so `pic.png` renamed to `photo` is `photo.png`, and to `photo.jpg` is that.
 */
export function renameTarget(from: string, input: string): string {
  const path = input.trim().replace(/^\/+/, "");
  const ext = keptExtension(from);
  if (isNote(from)) return path.replace(/(\.excalidraw)?\.md$/i, "") + ext;
  return keptExtension(path) ? path : path + ext;
}

/** Whether the app shows the file as a picture, by its extension: the kinds the window can draw in an `<img>`. */
export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);

/** Whether the app shows the file as a PDF, by its extension. */
export const isPdf = (path: string) => /\.pdf$/i.test(path);

/** Whether the app draws the file from its bytes and never reads it as text: a picture or a PDF. */
export const isDrawn = (path: string) => isImage(path) || isPdf(path);
