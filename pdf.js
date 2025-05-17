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
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => console.log('[PDF GENERATION COMPLETE]'));

  const safePageBreak = () => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
    }
  };

  const bold = (text, size = 12) => doc.font('Helvetica-Bold').fontSize(size).text(text);
  const regular = (text, size = 12) => doc.font('Helvetica').fontSize(size).text(text);

  if (options.type === 'shopping-list') {
    const sections = text.split(/(?=<b>.*?<\/b>)/);
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      if (!lines.length) return;
      const isHeader = lines[0].startsWith('<b>') && lines[0].endsWith('</b>');
      if (isHeader) {
        const heading = lines[0].replace(/<\/?b>/g, '').trim();
        safePageBreak();
        doc.moveDown(0.5);
        bold(heading + ':', 13);
        lines.slice(1).forEach(line => {
          safePageBreak();
          regular(line.replace(/^[-–•]\s*/, '').trim(), 12);
        });
      } else {
        lines.forEach(line => {
          safePageBreak();
          regular(line.trim(), 12);
        });
      }
    });
  } else if (options.type === 'recipes') {
    const recipes = text.split(/\n---+\n/);
    recipes.forEach((recipe, index) => {
      if (index !== 0) doc.addPage();
      const lines = recipe.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        safePageBreak();

        if (/^\*\*Meal Name:\*\*/i.test(trimmed)) {
          bold(trimmed.replace(/\*\*/g, '').replace('Meal Name:', '').trim(), 14);
        } else if (/^\*\*Ingredients:\*\*/i.test(trimmed)) {
          doc.moveDown(0.3);
          bold('Ingredients:', 12);
        } else if (/^\*\*Instructions:\*\*/i.test(trimmed)) {
          doc.moveDown(0.3);
          bold('Instructions:', 12);
        } else if (/^\*\*Prep Time:\*\*/i.test(trimmed)) {
          doc.moveDown(0.3);
          regular(trimmed.replace(/\*\*/g, ''), 12);
        } else if (/^\*\*Macros:\*\*/i.test(trimmed)) {
          doc.moveDown(0.3);
          bold('Macros:', 12);
        } else {
          if (idx > 0 && lines[idx - 1].trim() === '') return;
          regular(trimmed, 12);
        }
      });
    });
  } else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      safePageBreak();
      const trimmed = line.trim();
      if (/^Meal Plan for /i.test(trimmed)) {
        bold(trimmed, 14);
      } else if (/^([A-Z][a-z]+day)/.test(trimmed)) {
        doc.moveDown(0.5);
        bold(trimmed, 12);
      } else {
        regular(trimmed, 12);
      }
    });
  }

  doc.end();

  return new Promise(resolve => {
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
