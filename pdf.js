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

  if (options.type === 'shoppingList') {
    const sections = text.split(/(?=^[A-Za-z ]+:)/m);
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      const headingLine = lines[0].trim();
      const heading = headingLine.replace(/:$/, '');

      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).text(heading);
      doc.moveDown(0.3);

      lines.slice(1).join(',').split(/,\s*/).forEach(item => {
        const cleanedItem = item.trim().replace(/^[-–•]\s*/, '');
        if (cleanedItem) {
          doc.font('Helvetica').fontSize(12).text(cleanedItem);
        }
      });

      doc.moveDown(1.5);
    });
  } else if (options.layout === 'columns') {
    renderRecipeTextInSingleColumn(doc, text, options);
  } else {
    doc.font('Helvetica');
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (/^<b>.*<\/b>$/.test(trimmed)) {
        const clean = trimmed.replace(/<\/?b>/g, '');
        doc.font('Helvetica-Bold').text(clean).moveDown(0.5);
      } else {
        doc.font('Helvetica').text(trimmed).moveDown(0.5);
      }
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

function renderRecipeTextInSingleColumn(doc, text, options = {}) {
  const lines = text.split('\n');
  let currentMeal = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect and format title
    const titleMatch = line.match(/^(Breakfast|Lunch|Supper):\s*\*\*(.*?)\*\*$/);
    if (titleMatch) {
      currentMeal = titleMatch[1];
      const title = titleMatch[2];
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(14).text(`${currentMeal}: ${title}`);
      doc.moveDown(0.5);
      continue;
    }

    if (/^Ingredients:/i.test(line)) {
      doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
      const ingredientLines = [];
      i++;
      while (i < lines.length && lines[i].trim() && !/^Instructions:/i.test(lines[i])) {
        ingredientLines.push(lines[i].replace(/^[-•]\s*/, '').trim());
        i++;
      }
      i--; // step back since outer loop also increments
      ingredientLines.forEach(ing => {
        doc.font('Helvetica').fontSize(12).text(ing);
      });
      doc.moveDown(0.5);
      continue;
    }

    if (/^Instructions:/i.test(line)) {
      doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
      const instructions = [];
      i++;
      while (i < lines.length && lines[i].trim() && !/^Prep & Cook Time:/i.test(lines[i]) && !/^Macros:/i.test(lines[i])) {
        instructions.push(lines[i].trim());
        i++;
      }
      i--;
      instructions.forEach(inst => {
        doc.font('Helvetica').fontSize(12).text(inst);
      });
      doc.moveDown(0.5);
      continue;
    }

    if (/^Prep & Cook Time:/i.test(line)) {
      doc.font('Helvetica-Bold').fontSize(12).text('Prep & Cook Time:');
      doc.font('Helvetica').fontSize(12).text(line.replace(/^Prep & Cook Time:\s*/i, ''));
      doc.moveDown(0.25);
      continue;
    }

    if (/^Macros:/i.test(line)) {
      doc.font('Helvetica-Bold').fontSize(12).text('Macros:');
      doc.font('Helvetica').fontSize(12).text(line.replace(/^Macros:\s*/i, ''));
      doc.moveDown(2);
      continue;
    }

    // Fallback
    doc.font('Helvetica').fontSize(12).text(line);
  }
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
