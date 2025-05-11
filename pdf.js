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
  } else if (options.type === 'recipes') {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      if (!trimmed) {
        doc.moveDown(1);
        return;
      }

      if (/^Meal Type:/i.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else if (/^(Breakfast|Lunch|Supper|Snack):\s*/i.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^Ingredients:/i.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
      } else if (/^Instructions:/i.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
      } else if (/^Prep.*Time:/i.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(12).text(trimmed);
      } else if (/^Macros:/i.test(trimmed)) {
        doc.font('Helvetica').fontSize(12).text(trimmed);
        doc.moveDown(2);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
    });
  } else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^\w+day(\s+[-–]\s+Busy:.*?)?$/i.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else if (/^(Breakfast|Lunch|Supper|Snack):/i.test(trimmed)) {
        const label = trimmed.split(':')[0];
        const name = trimmed.split(':').slice(1).join(':');
        const cleaned = name.replace(/\(.*?\)/g, '').replace(/cooked.*$/, '').trim();
        doc.font('Helvetica').fontSize(12).text(`${label}: ${cleaned}`);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
      if (idx < lines.length - 1) doc.moveDown(0.5);
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
  // no changes from canvas for now
}

export async function uploadPdfToS3(buffer, filename) {
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
