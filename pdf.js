// pdf.js
import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import stream from 'stream';
import { promisify } from 'util';

const finished = promisify(stream.finished);

export async function createPdfFromText(text) {
  console.log('[createPdfFromText] Generating PDF for content...');
  const doc = new PDFDocument();
  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => console.log('[createPdfFromText] PDF generation complete.'));
  doc.text(text);
  doc.end();
  await finished(doc);
  return Buffer.concat(buffers);
}

export async function uploadPdfToS3(buffer, filename) {
  console.log(`[uploadPdfToS3] Uploading ${filename} to S3...`);
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: filename,
    Body: buffer,
    ContentType: 'application/pdf'
  });

  await s3.send(command);
  console.log(`[uploadPdfToS3] Upload complete, generating signed URL...`);

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return url;
}
