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
  const blocks = text.split(/\n(?=\s*(Breakfast|Lunch|Supper):)/);
  doc.font('Helvetica');

  blocks.forEach(paragraph => {
    const trimmed = paragraph.trim();

    if (/^(Breakfast|Lunch|Supper):\s*\*{1,2}(.*?)\*{1,2}$/.test(trimmed)) {
      const match = trimmed.match(/^(Breakfast|Lunch|Supper):\s*\*{1,2}(.*?)\*{1,2}$/);
      const mealType = match[1];
      const title = match[2];
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(14).text(`${mealType}: ${title}`);
      doc.moveDown(0.5);
    } else if (/^Ingredients:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Ingredients:');
      doc.moveDown(0.25);
      const items = trimmed.replace(/^Ingredients:\s*/i, '').split(/,\s*/);
      items.forEach(item => {
        if (item.trim()) {
          doc.font('Helvetica').fontSize(12).text(item.trim());
        }
      });
      doc.moveDown(1);
    } else if (/^Instructions:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Instructions:');
      const steps = trimmed.replace(/^Instructions:\s*/i, '').split(/\d+\.\s*/).filter(Boolean);
      steps.forEach((step, i) => {
        doc.font('Helvetica').fontSize(12).text(`${i + 1}. ${step.trim()}`);
      });
      doc.moveDown(1);
    } else if (/^Prep & Cook Time:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Prep & Cook Time:');
      doc.font('Helvetica').text(trimmed.replace(/^Prep & Cook Time:\s*/i, ''));
      doc.moveDown(0.25);
    } else if (/^Macros:/i.test(trimmed)) {
      doc.font('Helvetica-Bold').text('Macros:');
      doc.font('Helvetica').text(trimmed.replace(/^Macros:\s*/i, ''));
      doc.moveDown(2);
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
