
import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export async function createPdfFromText(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const buffers = [];

    // Bold headings like <b>Monday</b>
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (line.startsWith('<b>') && line.endsWith('</b>')) {
        const content = line.replace(/<\/?b>/g, '');
        doc.font('Helvetica-Bold').fontSize(14).text(content, { underline: false });
      } else if (line.startsWith('_') && line.endsWith('_')) {
        const content = line.replace(/^_(.*?)_$/, '$1');
        doc.font('Helvetica-Oblique').fontSize(12).text(content);
      } else {
        doc.font('Helvetica').fontSize(12).text(line);
      }
      if (idx < lines.length - 1) doc.moveDown(0.5);
    });

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });

    doc.end();
  });
}

export async function uploadPdfToS3(buffer, key) {
  const bucketName = process.env.AWS_BUCKET_NAME;
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf'
  });

  await s3.send(command);

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return url;
}
