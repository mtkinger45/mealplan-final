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
  doc.on('end', () => console.log('[PDF] Document rendering complete.'));

  const safePageBreak = (threshold = 100) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - threshold) {
      doc.addPage();
    }
  };

  if (options.type === 'recipes') {
    const lines = text.split('\n').filter(Boolean);
    lines.forEach((line, index) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('**Meal Name:**')) {
        if (index !== 0) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(14).text(trimmed.replace('**Meal Name:**', '').trim());
      } else if (trimmed.startsWith('**Ingredients:**')) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
      } else if (trimmed.startsWith('**Instructions:**')) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
      } else if (trimmed.startsWith('**Prep Time:**') || trimmed.startsWith('**Macros:**')) {
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(12).text(trimmed.replace(/\*\*/g, ''));
      } else if (/^\d+\./.test(trimmed)) {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      } else if (/^-/.test(trimmed)) {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      } else {
        doc.font('Helvetica').fontSize(12).text(trimmed);
      }
    });
  } else if (options.type === 'shopping-list') {
    const sectionRegex = /^(Produce|Meats?|Dairy|Pantry|Frozen|Bakery|Spices|Other|On-?hand Ingredients( Used)?):/i;
    const lines = text.split('\n');
    let currentSection = '';
    let sectionItems = [];
    const organizedSections = {};

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (sectionRegex.test(trimmed)) {
        if (currentSection && sectionItems.length) {
          organizedSections[currentSection] = [...(organizedSections[currentSection] || []), ...sectionItems];
        }
        currentSection = trimmed.replace(/:$/, '');
        sectionItems = [];
      } else {
        sectionItems.push(trimmed.replace(/^[-•\u2022]\s*/, ''));
      }
    });

    if (currentSection && sectionItems.length) {
      organizedSections[currentSection] = [...(organizedSections[currentSection] || []), ...sectionItems];
    }

    const sectionKeys = Object.keys(organizedSections);
    if (sectionKeys.length === 0) {
      doc.font('Helvetica').fontSize(12).text(text);
    } else {
      sectionKeys.forEach(section => {
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(13).text(section);
        organizedSections[section].forEach(item => {
          doc.font('Helvetica').fontSize(12).text(`• ${item}`);
        });
      });
    }
  } else {
    const lines = text.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        doc.moveDown();
        return;
      }
      safePageBreak();
      doc.font('Helvetica').fontSize(12).text(trimmed);
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
