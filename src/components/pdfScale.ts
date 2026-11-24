// The sizes a PDF is drawn at (PdfView.tsx). Pure functions: no React and no DOM (self-check: pdfScale.test.mjs).

/** CSS pixels per PDF point: at 100% a page is as large as printed, as in pdf.js's own viewer. */
export const CSS_PER_POINT = 96 / 72;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** Each zoom step multiplies or divides by this. */
const STEP = 1.25;
/** The space on each side of a page, in CSS pixels. */
export const PAGE_GAP = 16;

/** The zoom one step in from `zoom` (`direction` 1) or out (-1), within MIN_ZOOM to MAX_ZOOM, rounded to whole percents. */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  const next = Math.round(zoom * STEP ** direction * 100) / 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/**
 * The zoom at which the widest page fills `width` CSS pixels less a gap on both sides. `pageWidth` is in points.
 * Never above 200%, so a narrow page in a wide pane is not blown up, and never under MIN_ZOOM.
 */
export function fitZoom(width: number, pageWidth: number): number {
  if (!(width > 0 && pageWidth > 0)) return 1;
  return Math.min(2, Math.max(MIN_ZOOM, (width - 2 * PAGE_GAP) / (pageWidth * CSS_PER_POINT)));
}

/** WebKit draws nothing on a canvas over about 16.7 million pixels; a page stays under this. */
const MAX_PIXELS = 16_000_000;

/**
 * Device pixels per CSS pixel for the canvas of a page `width` by `height` CSS pixels: the screen's `ratio`, less
 * when that would make the canvas larger than WebKit draws. A page zoomed far in is then a little blurred, not blank.
 */
export function canvasRatio(width: number, height: number, ratio: number): number {
  return Math.min(ratio, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
}

/** Base64 as bytes. */
export function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
