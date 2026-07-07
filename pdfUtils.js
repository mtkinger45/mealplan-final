import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export async function createPdfFromText(title, text) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 50;
  const lineHeight = fontSize * 1.5;
  const maxWidth = width - margin * 2;

  let lines = [];
  let currentLine = '';

  // Break long text into lines that fit the page
  text.split('\n').forEach(paragraph => {
    const words = paragraph.split(' ');
    words.forEach(word => {
      const testLine = currentLine + word + ' ';
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);
      if (testWidth > maxWidth) {
        lines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine = testLine;
      }
    });
    if (currentLine) {
      lines.push(currentLine.trim());
      currentLine = '';
    }
    lines.push(''); // Blank line between paragraphs
  });

  // Add title
  page.drawText(title, {
    x: margin,
    y: height - margin,
    size: fontSize + 4,
    font,
    color: rgb(0, 0, 0),
  });

  // Add text
  let y = height - margin - lineHeight;
  for (const line of lines) {
    if (y < margin) {
      // Add new page if needed
      page = pdfDoc.addPage();
      y = height - margin;
    }
    page.drawText(line, {
      x: margin,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    y -= lineHeight;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString('base64');
}
