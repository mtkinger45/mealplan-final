""// pdf.js
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

  const safePageBreak = (threshold = 100) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - threshold) {
      doc.addPage();
    }
  };

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    const onHand = [], rest = [];

    for (const sec of sections) {
      if (sec.includes('• On-hand Ingredients Used:')) onHand.push(sec);
      else rest.push(sec);
    }

    for (const sec of [...rest, ...onHand]) {
      const lines = sec.trim().split('\n');
      const heading = lines[0].replace(/:$/, '');
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);
      for (const line of lines.slice(1)) {
        safePageBreak();
        const item = line.trim().replace(/^[-–•]\s*/, '');
        if (item) doc.font('Helvetica').fontSize(12).text(`• ${item}`);
      }
      doc.moveDown(1.5);
    }
  }

  else if (options.type === 'recipes') {
    if (!text || text.trim().length === 0 || text.includes('No recipes')) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
    } else {
      const recipes = text.split(/---/);
      for (const rec of recipes) {
        const lines = rec.trim().split('\n');
        if (!lines.length) continue;

        doc.addPage();
        for (const line of lines) {
          safePageBreak();
          const trimmed = line.trim();

          if (/^\*\*Meal Name:\*\*/.test(trimmed)) {
            doc.font('Helvetica-Bold').fontSize(13).text(trimmed.replace(/^\*\*Meal Name:\*\*\s*/, ''));
          } else if (/^\*\*Ingredients:\*\*/.test(trimmed)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
          } else if (/^\*\*Instructions:\*\*/.test(trimmed)) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
          } else if (/^\*\*Prep Time:\*\*/.test(trimmed)) {
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*Prep Time:\*\*/, 'Prep Time:'));
          } else if (/^\*\*Macros:\*\*/.test(trimmed)) {
            doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*Macros:\*\*/, 'Macros:'));
          } else if (/^-\s+/.test(trimmed)) {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          } else if (/^\d+\.\s+/.test(trimmed)) {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          } else {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          }
        }
      }
    }
  }

  else {
    const lines = text.split('\n');
    for (const line of lines) {
      safePageBreak();
      const trimmed = line.trim();
      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
    }
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
  return await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
}
