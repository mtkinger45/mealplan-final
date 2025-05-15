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
  doc.on('end', () => console.log('[createPdfFromText] PDF generation complete.'));

  const safePageBreak = () => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
    }
  };

  if (options.type === 'recipes') {
    if (!text || text.includes('No recipes')) {
      doc.font('Helvetica-Bold').fontSize(14).text('⚠️ No recipes found or failed to generate.');
      doc.end();
      return new Promise((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
      });
    }

    const recipeChunks = text.split(/---+/);
    recipeChunks.forEach(chunk => {
      const lines = chunk.trim().split('\n');
      doc.addPage();
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        safePageBreak();

        if (trimmed.startsWith('**Meal') && trimmed.includes('Name:**')) {
          doc.font('Helvetica-Bold').fontSize(13).text(trimmed.replace(/\*\*/g, ''));
        } else if (trimmed.startsWith('**Ingredients:**')) {
          doc.moveDown(0.3);
          doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
        } else if (trimmed.startsWith('**Instructions:**')) {
          doc.moveDown(0.3);
          doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
        } else if (trimmed.startsWith('**Prep & Cook Time:**')) {
          doc.font('Helvetica').fontSize(12).text(trimmed.replace(/\*\*/g, ''));
        } else if (trimmed.startsWith('**Macros:**')) {
          doc.font('Helvetica').fontSize(12).text(trimmed.replace(/\*\*/g, ''));
        } else {
          if (/^\d+\./.test(trimmed)) {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          } else if (/^- /.test(trimmed)) {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          } else {
            doc.font('Helvetica').fontSize(12).text(trimmed);
          }
        }
      });
    });
  } else if (options.type === 'shoppingList') {
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
      const heading = lines[0].replace(/:$/, '');

      safePageBreak();
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);

      lines.slice(1).forEach(item => {
        safePageBreak();
        const cleaned = item.trim().replace(/^[-–•]\s*/, '');
        if (cleaned) {
          doc.font('Helvetica').fontSize(12).text(`• ${cleaned}`);
        }
      });

      doc.moveDown(1.5);
    });
  } else {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      safePageBreak();

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

  return getSignedUrl(s3, getCommand, { expiresIn: 3600 });
}
