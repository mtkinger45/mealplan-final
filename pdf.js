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
  doc.on('end', () => console.log('[PDF] PDF generation complete.'));

  const safePageBreak = () => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
    }
  };

  if (options.type === 'shopping-list') {
    const lines = text.split(/\n+/);
    let currentCategory = '';

    doc.font('Helvetica-Bold').fontSize(16).text('Shopping List:', { underline: false });
    doc.moveDown(1);

    for (let line of lines) {
      line = line.trim();
      if (!line || line.toLowerCase().includes('json') || line.startsWith('[') || line.startsWith('{')) continue;

      const match = line.match(/^\u2022\s*(\w+):\s*(.+)/);
      if (match) {
        const [_, category, items] = match;
        currentCategory = category.charAt(0).toUpperCase() + category.slice(1);
        doc.font('Helvetica-Bold').fontSize(13).text(currentCategory);
        doc.moveDown(0.2);

        const itemList = items.split(',').map(i => i.trim()).filter(Boolean);
        itemList.forEach(item => {
          safePageBreak();
          doc.font('Helvetica').fontSize(12).text(`• ${item}`);
        });

        doc.moveDown(0.5);
      }
    }
  }

  else if (options.type === 'recipes') {
    if (!text || text.trim().length === 0 || /no recipes/i.test(text)) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
    } else {
      const recipes = text.split(/---/);
      recipes.forEach((recipe, i) => {
        const lines = recipe.trim().split('\n');
        if (i > 0) doc.addPage();
        lines.forEach(line => {
          safePageBreak();
          if (/^\*\*Meal Name:\*\*/i.test(line)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(14).text(line.replace(/^\*\*Meal Name:\*\*/i, '').trim());
          } else if (/^\*\*Ingredients:\*\*/i.test(line)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
          } else if (/^\*\*Instructions:\*\*/i.test(line)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
          } else if (/^\*\*Prep.*Time:\*\*/i.test(line)) {
            doc.moveDown(0.3);
            doc.font('Helvetica').fontSize(12).text(line.replace(/^\*\*/, ''));
          } else if (/^\*\*Macros:\*\*/i.test(line)) {
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(12).text('Macros:');
          } else if (/^\d+\.\s+/.test(line)) {
            doc.font('Helvetica').fontSize(12).text(line);
          } else if (/^[-•]\s+/.test(line)) {
            doc.font('Helvetica').fontSize(12).text(line);
          } else {
            doc.font('Helvetica').fontSize(12).text(line);
          }
        });
      });
    }
  }

  else {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      safePageBreak();
      if (/^Meal Plan for /i.test(line)) {
        doc.font('Helvetica-Bold').fontSize(14).text(line);
      } else {
        doc.font('Helvetica').fontSize(12).text(line);
      }
      if (i < lines.length - 1) doc.moveDown(0.3);
    });
  }

  doc.end();
  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
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
