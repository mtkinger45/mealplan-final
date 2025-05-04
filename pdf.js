// pdf.js
import PDFDocument from 'pdfkit';
import getStream from 'get-stream';

export async function createPdfFromText(text) {
  const doc = new PDFDocument();
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {});

  doc.fontSize(12).text(text, {
    width: 450,
    align: 'left'
  });

  doc.end();

  const buffer = await getStream.buffer(doc);
  const base64 = buffer.toString('base64');
  return `data:application/pdf;base64,${base64}`;
}
