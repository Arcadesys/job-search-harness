import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { detectKind, extractResumeText, resumeLines } from './resume-extract';

test('résumé lines keep the person’s words and drop only bullets and blank runs', () => {
  assert.equal(resumeLines('  Alex Example \r\n\n• Led   a team of 4\n- Shipped v2\n1. First\n– Dash bullet\n'), 'Alex Example\nLed a team of 4\nShipped v2\nFirst\nDash bullet');
});

test('PDF, Word and text résumés become reviewable lines; other files are refused', async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([612, 792]);
  ['Alex Example', '• Built weekly dashboards for twelve teams.', 'Skills: SQL, Python'].forEach((line, i) => page.drawText(line, { x: 48, y: 740 - i * 24, size: 12, font }));
  const fromPdf = await extractResumeText(await pdf.save());
  assert.equal(fromPdf.kind, 'pdf');
  assert.deepEqual(fromPdf.text.split('\n'), ['Alex Example', 'Built weekly dashboards for twelve teams.', 'Skills: SQL, Python']);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alex Example</w:t></w:r></w:p><w:p><w:r><w:t>Cut report time by half.</w:t></w:r></w:p></w:body></w:document>');
  const fromDocx = await extractResumeText(await zip.generateAsync({ type: 'uint8array' }));
  assert.deepEqual([fromDocx.kind, fromDocx.text], ['docx', 'Alex Example\nCut report time by half.']);

  assert.equal((await extractResumeText(new TextEncoder().encode('Alex\n\nAnalyst'))).text, 'Alex\nAnalyst');
  assert.equal(detectKind(new Uint8Array([0, 1, 2, 3, 0])), null);
  await assert.rejects(extractResumeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])), /not supported/);
  await assert.rejects(extractResumeText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), /could not be read/);
});
