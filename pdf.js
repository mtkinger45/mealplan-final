// pdf.js
import PDFDocument from 'pdfkit';
import { Buffer } from 'node:buffer';
import getStream from 'get-stream';

export async function createPdfFromText(text) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument();
      const stream = doc.pipe(getStream.buffer());
      doc.fontSize(12).text(text || 'No content provided.', { align: 'left' });
      doc.end();
      const buffer = await stream;
      const base64 = buffer.toString('base64');
      resolve(base64);
    } catch (err) {
      reject(err);
    }
  });
}
