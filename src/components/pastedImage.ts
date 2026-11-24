// Where a pasted image goes and what it is called. Obsidian's defaults, so a vault reads the same in both apps:
// the vault root, `Pasted image YYYYMMDDHHmmss.<ext>` in local time, linked as `![[name]]`. The editor finds an
// image there by name (`imagePaths` in Editor.tsx). Self-check: pastedImage.test.mjs.

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

/** The file extension for an image's MIME type, or null for a type that is not an image the app knows. */
export function imageExtension(type: string): string | null {
  return EXTENSIONS[type.toLowerCase()] ?? null;
}

/**
 * The file name for an image pasted at `at`. `n` above 0 is for when that name is taken: ` 1`, ` 2`, ... before
 * the extension, as Obsidian does.
 */
export function pastedImageName(at: Date, ext: string, n = 0): string {
  const two = (v: number) => String(v).padStart(2, "0");
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `Pasted image ${stamp}${n > 0 ? ` ${n}` : ""}.${ext}`;
}
