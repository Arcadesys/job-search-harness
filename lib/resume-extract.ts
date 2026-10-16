/** Turns a résumé file into plain text on this computer. Nothing is uploaded and nothing is
 * rewritten: the person checks the text and each kept line becomes one claim to review. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export type ResumeKind = 'pdf' | 'docx' | 'text';

export function detectKind(bytes: Uint8Array): ResumeKind | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'docx';
  const sample = bytes.subarray(0, 4096);
  if (sample.some((byte) => byte === 0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - 4)); return 'text'; } catch { return null; }
}

/** One line per résumé line: trimmed, without bullet glyphs or blank runs. */
export function resumeLines(text: string) {
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/^\s*(?:[•●▪◦‣∙·*\-–—]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

async function pdfText(bytes: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, isEvalSupported: false });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const content = await (await document.getPage(n)).getTextContent();
      let page = '', lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2 && !page.endsWith('\n')) page += '\n';
        page += item.str + (item.hasEOL ? '\n' : '');
        lastY = y;
      }
      pages.push(page);
    }
    return { text: pages.join('\n'), pages: document.numPages };
  } finally { await task.destroy(); }
}

async function docxText(bytes: Uint8Array) {
  const mammoth = await import('mammoth');
  const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(bytes) });
  return { text: value, pages: null };
}

export async function extractResumeText(bytes: Uint8Array) {
  if (bytes.length > MAX_RESUME_BYTES) throw new Error('That file is larger than 10 MB. Save a smaller copy or paste the text instead.');
  const kind = detectKind(bytes);
  if (!kind) throw new Error('This file type is not supported. Use a PDF, a Word .docx file, or plain text.');
  let result: { text: string; pages: number | null };
  try {
    result = kind === 'pdf' ? await pdfText(bytes) : kind === 'docx' ? await docxText(bytes) : { text: new TextDecoder().decode(bytes), pages: null };
  } catch {
    throw new Error(kind === 'pdf' ? 'This PDF could not be read. If it is password-protected or a scanned image, paste the text instead.'
      : 'This Word file could not be read. Save it as .docx or PDF, or paste the text instead.');
  }
  const text = resumeLines(result.text);
  if (!text) throw new Error('No text was found. Scanned résumés are images; paste the text instead.');
  return { kind, text, lines: text.split('\n').length, pages: result.pages };
}
