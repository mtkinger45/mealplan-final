import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

export async function createPdfFromText(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = new PassThrough();
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString('base64');
      resolve(`data:application/pdf;base64,${base64}`);
    });
    doc.on('error', reject);

    doc.pipe(stream);
    doc.fontSize(12).text(text);
    doc.end();
  });
}