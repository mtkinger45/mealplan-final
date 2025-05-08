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
  const lines = text.trim().split('\n');
  let currentRecipe = [];

  function renderCurrentRecipe() {
    if (currentRecipe.length === 0) return;

    const block = currentRecipe.join('\n');
    const recipeLines = block.trim().split('\n');
    let meal = '', recipeName = '', startIdx = 0;

    const titleMatch = recipeLines[0]?.match(/^(Breakfast|Lunch|Supper):\s*(.*)$/);
    if (titleMatch) {
      meal = titleMatch[1];
      recipeName = titleMatch[2].replace(/\*\*/g, '');
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(14).text(`${meal}: ${recipeName}`);
      doc.moveDown(0.5);
      startIdx = 1;
    }

    for (let i = startIdx; i < recipeLines.length; i++) {
      const line = recipeLines[i].trim();

      if (/^Ingredients:/i.test(line)) {
        doc.font('Helvetica-Bold').fontSize(12).text('Ingredients:');
        const items = line.replace(/^Ingredients:\s*/i, '').split(/,\s*/);
        items.forEach(item => {
          const clarifiedItem = clarifyIngredient(item.trim());
          doc.font('Helvetica').fontSize(12).text(clarifiedItem);
        });
        doc.moveDown(0.5);
        continue;
      }

      if (/^Instructions:/i.test(line)) {
        doc.font('Helvetica-Bold').fontSize(12).text('Instructions:');
        i++;
        while (i < recipeLines.length && recipeLines[i].trim() && !/^Prep & Cook Time:/i.test(recipeLines[i]) && !/^Macros:/i.test(recipeLines[i])) {
          const instructionLine = recipeLines[i].trim();
          const stepMatch = instructionLine.match(/^(\d+)\.\s*(.*)$/);
          if (stepMatch) {
            doc.font('Helvetica').fontSize(12).text(`${stepMatch[1]}. ${stepMatch[2]}`);
          } else {
            doc.font('Helvetica').fontSize(12).text(instructionLine);
          }
          i++;
        }
        i--;
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
        doc.moveDown(1.25);
        continue;
      }

      doc.font('Helvetica').fontSize(12).text(line);
    }
    currentRecipe = [];
  }

  for (let line of lines) {
    if (/^(Breakfast|Lunch|Supper):/.test(line.trim())) {
      renderCurrentRecipe();
    }
    currentRecipe.push(line);
  }
  renderCurrentRecipe();
}

function clarifyIngredient(item) {
  const match = item.match(/^1\s*lb\s*beef/i);
  if (match) {
    return item.replace(/^1\s*lb\s*beef/i, '1 lb ground beef');
  }
  return item;
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
