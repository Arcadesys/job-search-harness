import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractResumePdfText } from './pdf-text';

async function syntheticPdf(pages: number, text = '') {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < pages; n++) {
    const page = pdf.addPage([612, 792]);
    if (text) page.drawText(text, { x: 40, y: 740, size: 12, lineHeight: 16, maxWidth: 260, font });
  }
  return pdf.save();
}

test('extracts real wrapped text from saved synthetic PDF bytes without mutating the input', async () => {
  const text = 'Fictional Example\nBuilt a synthetic reporting tool with carefully reviewed evidence and clear results.';
  const bytes = await syntheticPdf(2, text);
  const original = Uint8Array.from(bytes);
  const extracted = await extractResumePdfText(bytes);
  assert.equal(extracted.replace(/\s+/g, ' ').trim(), `${text} ${text}`.replace(/\s+/g, ' '));
  assert.deepEqual(bytes, original);
});

test('rejects invalid and empty PDF bytes instead of producing blank success', async () => {
  await assert.rejects(extractResumePdfText(new Uint8Array()), /empty/);
  await assert.rejects(extractResumePdfText(new Uint8Array([1, 2, 3])));
});

test('rejects PDFs over the byte limit before parsing', async () => {
  await assert.rejects(extractResumePdfText(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MB/);
});

test('accepts 20 pages but rejects 21 pages', async () => {
  assert.match(await extractResumePdfText(await syntheticPdf(20, 'Synthetic page')), /Synthetic page/);
  await assert.rejects(extractResumePdfText(await syntheticPdf(21, 'Synthetic page')), /20-page/);
});

test('rejects PDFs with no extractable text', async () => {
  await assert.rejects(extractResumePdfText(await syntheticPdf(1)), /no extractable text/);
});

test('rejects extracted text above 100,000 characters even in a small compressed PDF', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // Overlapping visible text keeps all strings within the page crop box.
  for (let n = 0; n < 1_100; n++) page.drawText('A'.repeat(100), { x: 20, y: 700, size: 1, font });
  const bytes = await pdf.save();
  assert.ok(bytes.byteLength < 5 * 1024 * 1024);
  await assert.rejects(extractResumePdfText(bytes), /100,000-character/);
});
