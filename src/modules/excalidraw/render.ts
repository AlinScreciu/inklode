// A drawing as an SVG, for embeds in notes.

import { exportToCanvas, exportToSvg } from "@excalidraw/excalidraw";
import type { SceneElement } from "./format";

type ExportOptions = Parameters<typeof exportToSvg>[0];

/**
 * Whether the app is in its dark appearance now: `data-appearance` on <html>, which the app keeps at
 * "light" or "dark", or the system's setting while that attribute is not there. Drawings follow this.
 */
export function isDark(): boolean {
  const appearance = document.documentElement.dataset.appearance;
  return appearance ? appearance === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The scene as an SVG in the app's light or dark look.
 * The background is transparent, so it sits on the note's own.
 */
export async function toSvg(elements: readonly SceneElement[], files: unknown): Promise<SVGSVGElement> {
  const shown = elements.filter((e) => !e.isDeleted) as unknown as ExportOptions["elements"];
  await loadFonts(shown);
  const svg = await exportToSvg({
    elements: shown,
    files: (files ?? null) as ExportOptions["files"],
    appState: { exportBackground: false, exportWithDarkMode: isDark() },
    // The SVG goes into this page, where `loadFonts` made the drawing's fonts available by name.
    skipInliningFonts: true,
  });
  return unlink(svg);
}

/**
 * Makes the fonts of these elements' text available to the page by name, which the SVG relies on. Excalidraw
 * registers and loads a drawing's fonts when it draws on a canvas, and has no call for that alone, so the text
 * is drawn once on a canvas of one pixel. A font that cannot be loaded leaves the text in a system font.
 */
async function loadFonts(elements: ExportOptions["elements"]): Promise<void> {
  const texts = elements.filter((e: { type: string }) => e.type === "text");
  if (texts.length === 0) return;
  await exportToCanvas({ elements: texts, files: null, getDimensions: () => ({ width: 1, height: 1, scale: 1 }) }).catch(() => {});
}

/**
 * Takes the web addresses off the links in a drawing's SVG. Excalidraw draws an element that has a link
 * as `<a href>`, and such a picture sits in the app's own page, where a click on it would take the
 * window to that address. Returns the same SVG.
 */
export function unlink<T extends Element>(svg: T): T {
  for (const link of svg.querySelectorAll("a")) {
    for (const name of [...link.getAttributeNames()]) {
      if (/^(xlink:)?href$|^target$/i.test(name)) link.removeAttribute(name);
    }
  }
  return svg;
}
