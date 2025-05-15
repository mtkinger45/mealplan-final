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

  const safePageBreak = () => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
    }
  };

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      const heading = lines[0];
      const items = lines.slice(1);
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);
      items.forEach(item => {
        safePageBreak();
        doc.font('Helvetica').fontSize(12).text(`• ${item.trim()}`);
      });
      doc.moveDown(1.5);
    });
  }

  else if (options.type === 'recipes') {
    const recipes = text.split(/\n---\n/);
    recipes.forEach(recipe => {
      const lines = recipe.trim().split('\n');
      doc.addPage();
      lines.forEach(line => {
        safePageBreak();
        if (/^\*\*Meal Name:\*\*/i.test(line)) {
          doc.font('Helvetica-Bold').fontSize(14).text(line.replace(/^\*\*(.*?)\*\*$/, '$1'));
        } else if (/^\*\*Ingredients:\*\*/i.test(line)) {
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
        } else if (/^\*\*Instructions:\*\*/i.test(line)) {
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
        } else if (/^\*\*Prep Time:\*\*/i.test(line)) {
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(12).text(line.replace(/^\*\*(.*?)\*\*$/, '$1'));
        } else if (/^\*\*Macros:\*\*/i.test(line)) {
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(12).text(line.replace(/^\*\*(.*?)\*\*$/, '$1'));
        } else if (/^- /.test(line)) {
          doc.font('Helvetica').fontSize(12).text(`• ${line.substring(2)}`);
        } else if (/^\d+\. /.test(line)) {
          doc.font('Helvetica').fontSize(12).text(line);
        } else {
          doc.font('Helvetica').fontSize(12).text(line);
        }
      });
    });
  }

  else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      safePageBreak();
      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
      if (idx < lines.length - 1) doc.moveDown(0.5);
    });
  }

  doc.end();
  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
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
  const getCommand = new GetObjectCommand({ Bucket: bucketName, Key: filename });
  const url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
  return url;
}
