// pdf.js, loaded the first time a PDF is shown (PdfView.tsx), so it is a chunk of its own. The legacy build,
// because the modern one uses JavaScript that Safari 18's WebKit does not have yet (`Map.getOrInsertComputed`).
// The worker is a file of the app's own build, which the content security policy allows (`script-src 'self'`).

import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import worker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = worker;

export { getDocument, RenderingCancelledException, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
