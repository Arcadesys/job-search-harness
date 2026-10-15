import type { TextContent } from 'pdfjs-dist/types/src/display/api';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 20;
const MAX_TEXT_CHARACTERS = 100_000;

/** Independently reads saved PDF bytes; never treats unreadable/blank output as success. */
export async function extractResumePdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) throw new Error('Resume PDF is empty.');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('Resume PDF exceeds the 5 MB extraction limit.');

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    // Copy because PDF.js may transfer its input buffer to its worker.
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    // No URL, CMap URL, standard-font URL or other external resource source is
    // supplied. Extraction uses these bytes and bundled parser code only.
  });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new Error('Resume PDF exceeds the 20-page extraction limit.');
    const parts: string[] = [];
    let length = 0;
    const append = (part: string) => {
      length += part.length;
      if (length > MAX_TEXT_CHARACTERS) throw new Error('Resume PDF exceeds the 100,000-character extraction limit.');
      parts.push(part);
    };
    for (let n = 1; n <= document.numPages; n++) {
      if (n > 1) append('\n');
      const page = await document.getPage(n);
      const reader = page.streamTextContent().getReader();
      let complete = false;
      let firstItem = true;
      try {
        // Consume incrementally rather than accumulating an unbounded page.
        while (true) {
          const { value, done } = await reader.read();
          if (done) { complete = true; break; }
          for (const item of (value as TextContent).items) {
            if (!('str' in item)) continue;
            if (!firstItem) append(' ');
            append(item.str);
            firstItem = false;
          }
        }
      } finally {
        try { if (!complete) await reader.cancel(new Error('Resume PDF text extraction stopped.')); }
        finally { reader.releaseLock(); page.cleanup(); }
      }
    }
    const text = parts.join('');
    if (!text.trim()) throw new Error('Resume PDF has no extractable text; image-only or blank PDFs cannot be verified.');
    return text;
  } finally {
    // Loading-task destruction also destroys the document transport and pages,
    // and handles failed loading where no document proxy was ever returned.
    await task.destroy();
  }
}
