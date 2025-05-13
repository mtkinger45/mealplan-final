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
      const headingLine = lines[0].trim();
      const heading = headingLine.replace(/:$/, '');

      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);

      lines.slice(1).join(',').split(/,\s*/).forEach(item => {
        const cleanedItem = item.trim().replace(/^[-–•]\s*/, '');
        if (cleanedItem) {
          doc.font('Helvetica').fontSize(12).text(cleanedItem);
        }
      });

      doc.moveDown(1.5);
    });
  } else if (options.type === 'columns') {
    renderRecipeTextInColumns(doc, text);
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

function renderRecipeTextInColumns(doc, text) {
  const columnWidth = 250;
  const gutter = 30;
  const leftMargin = doc.page.margins.left;
  const topMargin = doc.page.margins.top;

  let x = leftMargin;
  let y = topMargin;
  const recipes = text.split(/(?=^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (Breakfast|Lunch|Supper):)/m);

  recipes.forEach(recipe => {
    const lines = recipe.trim().split('\n');
    if (lines.length === 0) return;

    // Bolded title
    doc.font('Helvetica-Bold').fontSize(14).text(lines[0], x, y, { width: columnWidth, align: 'left' });
    y = doc.y + 5;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^Ingredients:/i.test(line)) {
        doc.font('Helvetica-Bold').text('Ingredients:', x, y, { width: columnWidth });
        y = doc.y + 2;
      } else if (/^Instructions:/i.test(line)) {
        doc.font('Helvetica-Bold').text('Instructions:', x, y, { width: columnWidth });
        y = doc.y + 2;
      } else if (/^Prep & Cook Time:/i.test(line)) {
        doc.font('Helvetica').text(line, x, y, { width: columnWidth });
        y = doc.y + 2;
      } else if (/^Macros:/i.test(line)) {
        doc.font('Helvetica').text(line, x, y, { width: columnWidth });
        y = doc.y + 20;
        continue;
      } else {
        doc.font('Helvetica').text(line, x, y, { width: columnWidth });
        y = doc.y + 2;
      }

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
    }
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
