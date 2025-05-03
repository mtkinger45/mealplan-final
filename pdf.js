import PDFDocument from 'pdfkit';
import getStream from 'get-stream';

export async function createPdfFromText(text) {
  const doc = new PDFDocument();
  doc.text(text);
  doc.end();
  const buffer = await getStream.buffer(doc);
  return 'data:application/pdf;base64,' + buffer.toString('base64');
}
