import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

type PdfLead = { title: string; organization: string; location: string; sourceUrl: string; postingSourceNote: string };
type PdfDraft = { resumeVariant: string; outreach: string; truthSnapshot: Array<{ id: string; claim: string; sourceNote: string }> };

export async function renderApplicationPdf(lead: PdfLead, draft: PdfDraft): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await readFile(path.join(process.cwd(), 'assets/fonts/AtkinsonHyperlegible-Regular.ttf')));
  const bold = await doc.embedFont(await readFile(path.join(process.cwd(), 'assets/fonts/AtkinsonHyperlegible-Bold.ttf')));
  const supported = [new Set(regular.getCharacterSet()), new Set(bold.getCharacterSet())];
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 56;
  const bodySize = 13;
  const bodyLeading = 20;
  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function nextPage() { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  function printLine(value: string, font: PDFFont, size = bodySize, leading = bodyLeading) {
    if (y - leading < margin) nextPage();
    for (const point of value) if (!supported[font === regular ? 0 : 1].has(point.codePointAt(0)!)) throw new Error('PDF text contains a character this font cannot display. Edit the draft or use the text export.');
    page.drawText(value, { x: margin, y, size, font, color: rgb(0.06, 0.06, 0.09) });
    y -= leading;
  }
  function paragraph(value: string, font = regular, size = bodySize, leading = bodyLeading, gap = 0) {
    for (const sourceLine of value.split(/\r?\n/)) {
      if (!sourceLine) { y -= leading / 2; continue; }
      let line = '';
      for (const word of sourceLine.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= pageWidth - 2 * margin) { line = candidate; continue; }
        if (line) printLine(line, font, size, leading);
        line = '';
        for (const character of word) {
          if (font.widthOfTextAtSize(line + character, size) > pageWidth - 2 * margin && line) { printLine(line, font, size, leading); line = ''; }
          line += character;
        }
      }
      if (line) printLine(line, font, size, leading);
    }
    y -= gap;
  }
  function heading(value: string) { if (y < margin + 75) nextPage(); paragraph(value, bold, 17, 25, 10); }

  paragraph('PRIVATE APPLICATION DRAFT · REVIEW BEFORE USE', bold, 13, 20, 12);
  paragraph('Check every edited claim against the saved truth snapshot before use.', regular, 13, 20, 12);
  heading(lead.title);
  paragraph([lead.organization, lead.location].filter(Boolean).join(' · '));
  y -= 10;
  heading('Résumé variant');
  paragraph(draft.resumeVariant);
  y -= 10;
  heading('Outreach draft · unsent');
  paragraph(draft.outreach);
  y -= 10;
  heading('Truth claims used · saved snapshot');
  for (const claim of draft.truthSnapshot ?? []) {
    paragraph(`[${claim.id}] ${claim.claim}`, bold);
    paragraph(`Source note: ${claim.sourceNote}`);
    y -= 8;
  }
  heading('Posting source');
  paragraph(lead.sourceUrl);
  paragraph(lead.postingSourceNote);
  return doc.save();
}
