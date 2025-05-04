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

    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const boldMatch = line.match(/^<b>(.*)<\/b>$/);
      const italicMatch = line.match(/^_(.*)_$/);

      if (boldMatch) {
        doc.font('Helvetica-Bold').fontSize(14).text(boldMatch[1]);
      } else if (italicMatch) {
        doc.font('Helvetica-Oblique').fontSize(12).text(italicMatch[1]);
      } else {
        // Remove inline <b> or <i> for now and print as normal
        const cleanedLine = line
          .replace(/<\/?b>/g, '')
          .replace(/<\/?i>/g, '');
        doc.font('Helvetica').fontSize(12).text(cleanedLine);
      }

      if (idx < lines.length - 1) {
        doc.moveDown(0.5);
      }
    });

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
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
  return await getSignedUrl(s3, command, { expiresIn: 3600 });
}
