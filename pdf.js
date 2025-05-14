// Updated pdf.js
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

  const safePageBreak = (threshold = 100) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - threshold) {
      doc.addPage();
    }
  };

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    const onHand = sections.filter(s => s.includes('On-hand Ingredients Used:'));
    const rest = sections.filter(s => !s.includes('On-hand Ingredients Used:'));

    [...rest, ...onHand].forEach(section => {
      const [heading, ...lines] = section.trim().split('
');
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading.replace(/:$/, ''));
      doc.moveDown(0.3);
      lines.forEach(item => {
        const clean = item.trim().replace(/^[-–•]\s*/, '');
        if (clean) {
          safePageBreak();
          doc.font('Helvetica').fontSize(12).text(`• ${clean}`);
        }
      });
      doc.moveDown(1.5);
    });
  } else if (options.type === 'recipes') {
    if (!text.trim()) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
    } else {
      const lines = text.split('
');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return doc.moveDown(1);
        safePageBreak();
        if (/^\*\*(.*?)\*\*/.test(trimmed)) {
          doc.addPage();
          doc.font('Helvetica-Bold').fontSize(14).text(trimmed.replace(/\*\*/g, ''));
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
          doc.addPage();
        } else {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        }
      });
    }
  } else {
    text.split('
').forEach((line, idx, arr) => {
      const trimmed = line.trim();
      if (!trimmed) return doc.moveDown(1);
      safePageBreak();
      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^(Day \d+:\s+.*?)$/i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else if (/^(Breakfast|Lunch|Supper|Snack):/i.test(trimmed)) {
        const [label, ...name] = trimmed.split(':');
        doc.font('Helvetica').fontSize(12).text(`${label}: ${name.join(':').trim()}`);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
      if (idx < arr.length - 1) doc.moveDown(0.5);
    });
  }

  doc.end();
  return new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(buffers))));
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

  return getSignedUrl(s3, getCommand, { expiresIn: 3600 });
}
