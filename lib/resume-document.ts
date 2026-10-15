import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import type { MaterialManifest, WorkflowSettings } from './job-workflow';

type Line = { text: string; x: number; y: number; width: number; height: number; page: number };
/** A standalone export, deliberately distinct from the private review packet. */
export async function renderResumeDocument(manifest: MaterialManifest, links: WorkflowSettings['links'], outreachOnly = false) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const directory = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
  const regular = await doc.embedFont(await readFile(path.join(directory, 'AtkinsonHyperlegible-Regular.ttf')));
  const bold = await doc.embedFont(await readFile(path.join(directory, 'AtkinsonHyperlegible-Bold.ttf')));
  const supported = { regular: new Set(regular.getCharacterSet()), bold: new Set(bold.getCharacterSet()) };
  const margin = 48, width = 612, height = 792, usable = width - margin * 2;
  let page = doc.addPage([width, height]), y = height - margin;
  const lines: Line[] = [];
  const next = () => { page = doc.addPage([width, height]); y = height - margin; };
  const print = (text: string, heading = false, url?: string) => {
    const font = heading ? bold : regular, size = heading ? 17 : 13, leading = heading ? 25 : 19;
    if (y < margin + leading) next();
    const chars = heading ? supported.bold : supported.regular;
    if ([...text].some((char) => !chars.has(char.codePointAt(0)!))) throw new Error('A résumé character is not supported by the font. Use an approved alternative or another template.');
    const lineWidth = font.widthOfTextAtSize(text, size);
    if (lineWidth > usable + 0.01) throw new Error('A résumé line exceeds its page bounds.');
    page.drawText(text, { x: margin, y, size, font, color: rgb(0.04, 0.04, 0.04) });
    lines.push({ text, x: margin, y, width: lineWidth, height: size, page: doc.getPageCount() });
    if (url) {
      page.drawLine({ start: { x: margin, y: y - 2 }, end: { x: margin + lineWidth, y: y - 2 }, thickness: 1, color: rgb(0.04, 0.04, 0.04) });
      const annotation = doc.context.register(doc.context.obj({ Type: PDFName.of('Annot'), Subtype: PDFName.of('Link'),
        Rect: [margin, y - 3, margin + lineWidth, y + size], Border: [0, 0, 0],
        A: { Type: PDFName.of('Action'), S: PDFName.of('URI'), URI: PDFString.of(url) } }));
      page.node.addAnnot(annotation);
    }
    y -= leading;
  };
  const paragraph = (text: string, heading = false, url?: string) => {
    const font = heading ? bold : regular, size = heading ? 17 : 13;
    for (const source of text.split(/\r?\n/)) {
      if (!source) { y -= 8; continue; }
      let line = '';
      for (const word of source.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= usable) { line = candidate; continue; }
        if (line) print(line, heading, url);
        line = '';
        for (const character of word) {
          if (line && font.widthOfTextAtSize(line + character, size) > usable) { print(line, heading, url); line = ''; }
          line += character;
        }
      }
      if (line) print(line, heading, url);
    }
  };
  if (outreachOnly) paragraph(manifest.outreach);
  else for (const [index, section] of manifest.sections.entries()) {
    if (y < margin + 80) next();
    paragraph(section.heading, true);
    for (const line of section.lines) paragraph(line);
    if (!index) for (const link of links) paragraph(link.label, false, link.url);
    y -= 12;
  }
  if (!lines.length) throw new Error('Document has no content.');
  if (lines.some((line) => line.y < margin || line.y + line.height > height - margin + 18)) throw new Error('Document content exceeds its page bounds.');
  return { bytes: await doc.save(), validation: { content: 'passed', bounds: 'passed', visual: 'pending', pageCount: doc.getPageCount(),
    text: lines.map((line) => line.text).join('\n'), links: outreachOnly ? [] : links }, lines };
}
