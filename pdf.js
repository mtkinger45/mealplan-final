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
    const lines = text.split('\n');
    let currentCategory = null;

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (/^[A-Za-z ]+:$/.test(trimmed)) {
        currentCategory = trimmed.replace(/:$/, '');
        doc.moveDown(1);
        doc.font('Helvetica-Bold').fontSize(13).text(currentCategory);
        doc.moveDown(0.5);
      } else {
        const cleanedItem = trimmed.replace(/^[-–•]\s*/, '');
        doc.font('Helvetica').fontSize(12).text(cleanedItem);
      }
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

      if (/^\*.*\*$/g.test(trimmed)) {
        doc.font('Helvetica-Bold').text(trimmed.replace(/\*/g, ''), x, y, {
          width: columnWidth,
          align: 'left'
        });
        y = doc.y + 10;
      } else if (/^Ingredients:/i.test(trimmed)) {
        doc.font('Helvetica-Bold').text('Ingredients:', x, y, {
          width: columnWidth,
          align: 'left'
        });
        y = doc.y + 5;

        const items = trimmed.replace(/^Ingredients:\s*/i, '').split(/[\,\n]+/);
        items.forEach(item => {
          if (item.trim()) {
            doc.font('Helvetica').text('• ' + item.trim(), x, y, {
              width: columnWidth,
              align: 'left'
            });
            y = doc.y + 2;
          }
        });

        y += 10;
      } else if (/^\s*-\s*\w+:\s+.+\(.+\)/.test(trimmed)) {
        const match = trimmed.match(/^\s*-\s*(\w+):\s+(.+?)\s*\((.*?)\)$/);
        if (match) {
          const mealType = match[1];
          const title = match[2];
          const ingredients = match[3].split(',');

          doc.font('Helvetica-Bold').text(`${mealType}: ${title}`, x, y, {
            width: columnWidth,
            align: 'left'
          });
          y = doc.y + 2;

          ingredients.forEach(ingredient => {
            doc.font('Helvetica').text('• ' + ingredient.trim(), x, y, {
              width: columnWidth,
              align: 'left'
            });
            y = doc.y + 2;
          });

          y += 8;
        } else {
          doc.font('Helvetica').text(trimmed, x, y, {
            width: columnWidth,
            align: 'left'
          });
          y = doc.y + 15;
        }
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
