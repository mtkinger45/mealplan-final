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

  const safePageBreak = () => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
    }
  };

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      const heading = lines[0].trim().replace(/:$/, '');
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);

      lines.slice(1).forEach(item => {
        safePageBreak();
        const cleanedItem = item.trim()
          .replace(/^[-–•]\s*/, '')
          .replace(/^([\d.]+)\s+(\w+)\s+(.*)/, '$1 $3 $2')
          .replace(/^([a-zA-Z]+):\s*(\d+)$/, '$2 $1');

        if (cleanedItem) {
          doc.font('Helvetica').fontSize(12).text(`• ${cleanedItem}`);
        }
      });
      doc.moveDown(1.5);
    });
  } else if (options.type === 'recipes') {
    const lines = text.split('\n');
    let currentSection = '';

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        doc.moveDown(1);
        return;
      }
      safePageBreak();

      if (/^\*\*Meal Name:\*\*/.test(trimmed)) {
        if (idx !== 0) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^\*\*Ingredients:\*\*/.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
        currentSection = 'ingredients';
      } else if (/^\*\*Instructions:\*\*/.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
        currentSection = 'instructions';
      } else if (/^\*\*Prep Time:\*\*/.test(trimmed)) {
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*/, '').replace(/\*\*$/, ''));
        currentSection = '';
      } else if (/^\*\*Macros:\*\*/.test(trimmed)) {
        doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*/, '').replace(/\*\*$/, ''));
        currentSection = '';
      } else {
        if (currentSection === 'ingredients') {
          doc.font('Helvetica').fontSize(12).text(`- ${trimmed}`);
        } else if (currentSection === 'instructions') {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        } else {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        }
      }
    });
  } else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      safePageBreak();
      const trimmed = line.trim();
      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
      if (idx < lines.length - 1) doc.moveDown(0.5);
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
