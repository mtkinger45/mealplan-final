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

  const safePageBreak = (doc, threshold = 100) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - threshold) {
      doc.addPage();
    }
  };

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    const onHandSection = [];
    const otherSections = [];

    sections.forEach(section => {
      if (section.includes('• On-hand Ingredients Used:')) {
        onHandSection.push(section);
      } else {
        otherSections.push(section);
      }
    });

    [...otherSections, ...onHandSection].forEach(section => {
      const lines = section.trim().split('\n');
      const headingLine = lines[0].trim();
      const heading = headingLine.replace(/:$/, '');

      safePageBreak(doc);
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);

      lines.slice(1).forEach(item => {
        safePageBreak(doc);
        const cleanedItem = item.trim()
          .replace(/^[-–•]\s*/, '')
          .replace(/^([\d.]+)\s+(\w+)\s+(.*)/, '$1 $3 $2')
          .replace(/^([a-zA-Z]+):\s*(\d+)$/, '$2 $1');

        if (cleanedItem) {
          safePageBreak(doc);
          doc.font('Helvetica').fontSize(12).text(`• ${cleanedItem}`);
        }
      });

      doc.moveDown(1.5);
    });
  }

  else if (options.type === 'recipes') {
    console.log('[PDF DEBUG] Generating recipe PDF...');
    if (!text || !text.includes('Ingredients:')) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
      doc.end();
      return new Promise((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
      });
    }

    const lines = text.split('\n');
    let inIngredients = false;
    let inInstructions = false;

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        doc.moveDown(1);
        return;
      }

      safePageBreak(doc);

      if (/^\*\*(.+?): (.+?)\*\*/.test(trimmed)) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed.replace(/\*\*/g, ''));
      } else if (/^Ingredients:/i.test(trimmed)) {
        inIngredients = true;
        inInstructions = false;
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
      } else if (/^Instructions:/i.test(trimmed)) {
        inIngredients = false;
        inInstructions = true;
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
      } else if (/^Prep.*Time:/i.test(trimmed)) {
        inIngredients = false;
        inInstructions = false;
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(12).text(trimmed);
      } else if (/^Macros:/i.test(trimmed)) {
        inIngredients = false;
        inInstructions = false;
        doc.font('Helvetica').fontSize(12).text(trimmed);
        doc.addPage();
      } else {
        if (inIngredients) {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        } else if (inInstructions && /^\d+\.\s+/.test(trimmed)) {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        } else {
          doc.font('Helvetica').fontSize(12).text(trimmed);
        }
      }
    });
  }

  else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      safePageBreak(doc);

      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^(Day \d+:\s+\w+day.*?)$/i.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else if (/^(Day \d+:\s+.*?)$/i.test(trimmed)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text(trimmed);
      } else if (/^(Breakfast|Lunch|Supper|Snack):/i.test(trimmed)) {
        const label = trimmed.split(':')[0];
        const name = trimmed.split(':').slice(1).join(':');
        doc.font('Helvetica').fontSize(12).text(`${label}: ${name}`);
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
