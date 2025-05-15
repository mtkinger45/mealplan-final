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

  const safePageBreak = (threshold = 100) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - threshold) {
      doc.addPage();
    }
  };

  if (options.type === 'recipes') {
    if (!text || text.trim().length === 0 || /no recipes/i.test(text)) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
      doc.end();
      return new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(buffers))));
    }

    const sections = text.split(/\*\*Meal \d+ Name:\*\*/).filter(Boolean);

    sections.forEach((block, idx) => {
      doc.addPage();
      const lines = block.trim().split('\n');

      // Print meal title
      doc.font('Helvetica-Bold').fontSize(14).text(`Meal ${idx + 1}`);
      doc.moveDown(0.5);

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        safePageBreak();

        if (/^\*\*Ingredients:\*\*/.test(trimmed)) {
          doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
        } else if (/^\*\*Instructions:\*\*/.test(trimmed)) {
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
        } else if (/^\*\*Prep & Cook Time:\*\*/.test(trimmed)) {
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(12).text('Prep & Cook Time:');
          doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*Prep & Cook Time:\*\*/, '').trim());
        } else if (/^\*\*Macros:\*\*/.test(trimmed)) {
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(12).text('Macros:');
          doc.font('Helvetica').fontSize(12).text(trimmed.replace(/^\*\*Macros:\*\*/, '').trim());
        } else if (/^\d+\./.test(trimmed)) {
          doc.font('Helvetica').fontSize(12).text(trimmed); // Instruction step
        } else {
          doc.font('Helvetica').fontSize(12).text(`• ${trimmed}`); // ingredient or misc
        }
      });
    });
  }

  else if (options.type === 'shoppingList') {
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
      const heading = lines[0].trim().replace(/:$/, '');

      safePageBreak();
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
  }

  else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      safePageBreak();

      if (/^Meal Plan for /i.test(trimmed)) {
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed);
      } else if (/^(Day \d+:\s+\w+day.*?)$/i.test(trimmed)) {
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
