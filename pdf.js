import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ...s3 client config...

export async function uploadPdfToS3(buffer, key) {
  const bucketName = process.env.AWS_BUCKET_NAME;

  // Step 1: Upload the file
  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf'
  });
  await s3.send(putCommand);

  // Step 2: Generate a GET link for downloading
  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  });

  const url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
  return url;
}


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
