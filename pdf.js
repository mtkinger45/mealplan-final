// pdf.js
import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export async function createPdfFromText(text) {
  const doc = new PDFDocument();
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(text, { align: 'left' });
    doc.end();
  });
}

export async function uploadPdfToS3(pdfBuffer, filename) {
  const bucketName = process.env.AWS_BUCKET_NAME;

  const uploadParams = {
    Bucket: bucketName,
    Key: filename,
    Body: pdfBuffer,
    ContentType: 'application/pdf'
  };

  const command = new PutObjectCommand(uploadParams);
  await s3.send(command);

  const url = await getSignedUrl(s3, command, { expiresIn: 60 * 60 });
  return url;
}
