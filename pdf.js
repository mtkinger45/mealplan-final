
// pdf.js
import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export async function createPdfFromText(text, options = {}) {
  console.log('[createPdfFromText] Generating PDF for content...');
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {
    console.log('[createPdfFromText] PDF generation complete.');
  });

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      const heading = lines.shift();

      if (heading && heading.trim()) {
        doc.moveDown(1);
        doc.font('Helvetica-Bold').fontSize(14).text(heading.replace(/:$/, ''));
        doc.moveDown(0.3);
      }

      lines.forEach(item => {
        const cleanedItem = item.trim().replace(/^[-–•]\s*/, '');
        if (cleanedItem) {
          doc.font('Helvetica').fontSize(12).text('\u2022 ' + cleanedItem, {
            indent: 20,
            paragraphGap: 2
          });
        }
      });

      doc.moveDown(1);
    });
  } else if (options.layout === 'columns') {
    doc.font('Helvetica');
    const columnWidth = 250;
    const gutter = 30;
    const leftMargin = doc.page.margins.left;
    const topMargin = doc.page.margins.top;

    let x = leftMargin;
    let y = topMargin;
    const lines = text.split(/\n{2,}/);

    lines.forEach((paragraph, i) => {
      const trimmed = paragraph.trim();

      if (y + 100 > doc.page.height - doc.page.margins.bottom) {
        if (x + columnWidth + gutter < doc.page.width - doc.page.margins.right) {
          x += columnWidth + gutter;
          y = topMargin;
        } else {
          doc.addPage();
          x = leftMargin;
          y = topMargin;
        }
      }

      if (/^Ingredients:/i.test(trimmed)) {
        doc.font('Helvetica-Bold').text('Ingredients:', x, y, {
          width: columnWidth,
          align: 'left'
        });
        y = doc.y + 5;

        const items = trimmed.replace(/^Ingredients:\s*/i, '').split(/[\,\n]+/);
        items.forEach(item => {
          if (item.trim()) {
            doc.font('Helvetica').text('\u2022 ' + item.trim(), x, y, {
              width: columnWidth,
              align: 'left'
            });
            y = doc.y + 2;
          }
        });

        y += 10;
      } else {
        doc.text(trimmed, x, y, {
          width: columnWidth,
          align: 'left'
        });
        y = doc.y + 15;
      }
    });
  } else {
    doc.font('Helvetica');
    text.split('\n').forEach((line) => {
      doc.text(line.trim()).moveDown(0.5);
    });
  }

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });
  });
}

export async function uploadPdfToS3(buffer, filename) {
  console.log(`[uploadPdfToS3] Uploading ${filename} to S3...`);

  const bucketName = process.env.AWS_BUCKET_NAME;

  const uploadCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: filename,
    Body: buffer,
    ContentType: 'application/pdf'
  });

  await s3.send(uploadCommand);

  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: filename
  });

  const url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
  return url;
}
