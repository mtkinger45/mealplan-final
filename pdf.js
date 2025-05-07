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
  } else if (options.layout === 'columns') {
    renderRecipeTextInSingleColumn(doc, text, options);
  } else {
    doc.font('Helvetica');
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (/^<b>.*<\/b>$/.test(trimmed)) {
        const clean = trimmed.replace(/<\/?b>/g, '');
        doc.font('Helvetica-Bold').text(clean).moveDown(0.5);
      } else {
        doc.font('Helvetica').text(trimmed).moveDown(0.5);
      }
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

function renderRecipeTextInSingleColumn(doc, text, options = {}) {
  const lines = text.split(/\n{2,}/);
  doc.font('Helvetica');

  lines.forEach(paragraph => {
    const trimmed = paragraph.trim();

    if (/^\*{1,2}.*\*{1,2}$/.test(trimmed)) {
      const title = trimmed.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '');
      doc.font('Helvetica-Bold').text(title);
      doc.moveDown(0.5);
    } else if (/^Ingredients:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Ingredients:');
      doc.moveDown(0.25);
      const items = trimmed.replace(/^Ingredients:\s*/i, '').split(/[\,\n]+/);
      items.forEach(item => {
        if (item.trim()) {
          doc.font('Helvetica').text('\u2022 ' + item.trim());
        }
      });
      doc.moveDown(1);
    } else if (/^Instructions:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Instructions:');
      doc.moveDown(0.25);
    } else if (/^Prep & Cook Time:/i.test(trimmed)) {
      doc.font('Helvetica').text(trimmed);
      doc.moveDown(0.25);
    } else if (/^Macros:/i.test(trimmed)) {
      doc.font('Helvetica').text(trimmed);
      doc.moveDown(1);
    } else {
      doc.font('Helvetica').text(trimmed);
      doc.moveDown(1);
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
