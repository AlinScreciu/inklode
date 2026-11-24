// A PDF in a pane (Workspace.tsx). pdf.js (pdfjs.ts) draws each page on a canvas once it scrolls near the
// pane's view, with the page's text over it in a see-through layer, so text can be selected and copied. A page
// that scrolls far away gives its canvas up again. The file's bytes come from the core (`attachment.read`):
// the content security policy lets the window fetch nothing but the app's own files and the core.

import { MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { call } from "../core/client";
import { canvasRatio, CSS_PER_POINT, fitZoom, fromBase64, PAGE_GAP, zoomStep } from "./pdfScale";
import type { PDFDocumentProxy, PDFPageProxy } from "./pdfjs";

interface Loaded {
  pdf: PDFDocumentProxy;
  pages: PDFPageProxy[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One page: a box of the page's size, with the canvas and the text in it while it is near the view. */
function Page({ page, zoom, root, onDrawn }: { page: PDFPageProxy; zoom: number; root: HTMLElement | null; onDrawn(drawn: boolean): void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const scale = zoom * CSS_PER_POINT;
  const viewport = page.getViewport({ scale });

  useEffect(() => {
    if (!box.current || !root) return;
    // A page height above and below the view, so scrolling finds the next page drawn.
    const watch = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: "100% 0px" });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [root]);

  useEffect(() => {
    const paper = canvas.current;
    const layer = text.current;
    if (!near || !paper || !layer) return;
    const ratio = canvasRatio(viewport.width, viewport.height, window.devicePixelRatio || 1);
    paper.width = Math.floor(viewport.width * ratio);
    paper.height = Math.floor(viewport.height * ratio);
    const task = page.render({ canvas: paper, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    let cancelText = () => {};
    let gone = false;
    void import("./pdfjs").then(({ RenderingCancelledException, TextLayer }) =>
      task.promise.then(
        () => {
          if (gone) return;
          onDrawn(true);
          layer.replaceChildren();
          const words = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
          cancelText = () => words.cancel();
          return words.render();
        },
        (e) => {
          if (!(e instanceof RenderingCancelledException)) console.warn(`PDF page ${page.pageNumber}: ${message(e)}`);
        },
      ),
    );
    return () => {
      gone = true;
      task.cancel();
      cancelText();
      onDrawn(false);
      // Gives the canvas's memory back: a page at 2x is 8 MB or more.
      paper.width = 0;
      paper.height = 0;
      layer.replaceChildren();
    };
    // `viewport` follows from `page` and `zoom`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, page, zoom]);

  return (
    <div
      ref={box}
      className="pdf-page"
      data-page={page.pageNumber}
      style={{ width: viewport.width, height: viewport.height, "--scale-factor": scale, "--total-scale-factor": scale } as React.CSSProperties}
    >
      {near && (
        <>
          <canvas ref={canvas} />
          <div ref={text} className="textLayer" />
        </>
      )}
    </div>
  );
}

/**
 * The pages of the PDF at `path`, one under the other, and a bar with the page count and the zoom. The zoom
 * starts at "fit width" and follows the pane's width until a zoom button is pressed.
 */
// shortcut: a PDF that changed on disk shows its new content only when it is opened again, and links inside it,
// its outline and search in it are not there; add pdf.js's AnnotationLayer and a find bar when PDFs are read a lot
// shortcut: no standard fonts or CMaps are shipped, so a PDF that does not embed its fonts is drawn with the
// system's, and one that needs a predefined CJK CMap shows no text; ship pdfjs-dist's `standard_fonts` and
// `cmaps` folders (2.4 MB, Foxit, Liberation and Adobe licences) and pass their URLs when that comes up
export function PdfView({ path }: { path: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [width, setWidth] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // Which pages have a drawn canvas, for `ui_state`.
  const [drawn, setDrawn] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    let stale = false;
    let loading: { destroy(): Promise<void> } | null = null;
    (async () => {
      const [pdfjs, file] = await Promise.all([import("./pdfjs"), call<{ data: string }>("attachment.read", { path })]);
      if (stale) return;
      // No WebAssembly (the policy has no `wasm-unsafe-eval`; pdf.js then decodes JPEG 2000 in JavaScript) and no
      // fetching from the worker: everything pdf.js needs is in the bytes.
      const task = pdfjs.getDocument({ data: fromBase64(file.data), useWasm: false, useWorkerFetch: false, enableXfa: false });
      loading = task;
      const pdf = await task.promise;
      // shortcut: every page is asked for its size up front, a moment for a few hundred pages; give the pages
      // the first page's size and correct each as it is drawn if PDFs of thousands of pages are opened
      const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
      if (!stale) setLoaded({ pdf, pages });
    })().catch((e) => stale || setFailed(message(e)));
    return () => {
      stale = true;
      void loading?.destroy();
    };
  }, [path]);

  useEffect(() => {
    if (!scroller) return;
    const watch = new ResizeObserver(() => setWidth(scroller.clientWidth));
    watch.observe(scroller);
    return () => watch.disconnect();
  }, [scroller]);

  const widest = Math.max(0, ...(loaded?.pages.map((p) => p.getViewport({ scale: 1 }).width) ?? []));
  const scale = zoom === "fit" ? fitZoom(width, widest) : zoom;
  const name = path.slice(path.lastIndexOf("/") + 1);

  if (failed) {
    return (
      <div className="attachment">
        <p className="attachment-text">Inklode cannot show this PDF: {failed}</p>
      </div>
    );
  }
  return (
    <div className="pdf-view" data-pages={loaded?.pages.length ?? 0} data-zoom={scale} data-fit={zoom === "fit"} data-drawn={[...drawn].sort((a, b) => a - b).join(",")}>
      <div className="pdf-bar">
        <span className="pdf-count">{loaded ? `${loaded.pages.length} ${loaded.pages.length === 1 ? "page" : "pages"}` : "Loading…"}</span>
        <button className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom(zoomStep(scale, -1))}>
          <ZoomOut size={15} />
        </button>
        <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom(zoomStep(scale, 1))}>
          <ZoomIn size={15} />
        </button>
        <button className="icon-button" aria-label="Fit width" title="Fit width" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
          <MoveHorizontal size={15} />
        </button>
      </div>
      <div className="pdf-pages" ref={setScroller} aria-label={name} tabIndex={0} style={{ "--pdf-gap": `${PAGE_GAP}px` } as React.CSSProperties}>
        {loaded &&
          width > 0 &&
          loaded.pages.map((page) => (
            <Page
              key={page.pageNumber}
              page={page}
              zoom={scale}
              root={scroller}
              onDrawn={(on) =>
                setDrawn((all) => {
                  if (all.has(page.pageNumber) === on) return all;
                  const next = new Set(all);
                  if (on) next.add(page.pageNumber);
                  else next.delete(page.pageNumber);
                  return next;
                })
              }
            />
          ))}
      </div>
    </div>
  );
}
