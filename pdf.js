// pdf.js - Meal Planner V3 PDF utilities
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

function collectPdf(doc) {
  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}

function addTitle(doc, title) {
  doc.font('Helvetica-Bold').fontSize(18).text(title, { align: 'center' });
  doc.moveDown(1);
}

function addSection(doc, title) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(14).text(title);
  doc.moveDown(0.2);
}

function addText(doc, text, options = {}) {
  if (doc.y > doc.page.height - 80) doc.addPage();
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 11).text(text, {
    lineGap: 3
  });
}

function addMealPlan(doc, cache) {
  addTitle(doc, `Meal Plan for ${cache.input?.name || 'Guest'}`);
  if (cache.plan?.summary) addText(doc, cache.plan.summary, { size: 11 });
  doc.moveDown(0.7);

  for (const day of cache.plan?.mealPlan || []) {
    addSection(doc, day.day);
    for (const meal of day.meals || []) {
      addText(doc, `${meal.type}: ${meal.title}`, { bold: true });
      if (meal.notes) addText(doc, meal.notes, { size: 10 });
      doc.moveDown(0.2);
    }
  }
}

function addShoppingList(doc, cache) {
  addTitle(doc, `Shopping List for ${cache.input?.name || 'Guest'}`);
  for (const section of cache.plan?.shoppingList || []) {
    addSection(doc, section.category || 'Other');
    for (const item of section.items || []) {
      const qty = item.quantity ? `${item.quantity} ` : '';
      const unit = item.unit ? `${item.unit} ` : '';
      const notes = item.notes ? ` (${item.notes})` : '';
      addText(doc, `• ${qty}${unit}${item.name}${notes}`);
    }
  }
}

function addRecipes(doc, cache) {
  addTitle(doc, `Recipes for ${cache.input?.name || 'Guest'}`);
  const recipes = cache.plan?.recipes || [];

  recipes.forEach((recipe, index) => {
    if (index > 0) doc.addPage();
    addSection(doc, `${recipe.day} ${recipe.mealType} – ${recipe.title}`);
    addText(doc, `Servings: ${recipe.servings || cache.input?.people || ''}`);
    addText(doc, `Prep: ${recipe.prepTime || 'N/A'} | Cook: ${recipe.cookTime || 'N/A'}`);

    addSection(doc, 'Ingredients');
    for (const item of recipe.ingredients || []) {
      addText(doc, `• ${item.quantity || ''} ${item.unit || ''} ${item.name}`.replace(/\s+/g, ' ').trim());
    }

    addSection(doc, 'Instructions');
    (recipe.instructions || []).forEach((step, i) => addText(doc, `${i + 1}. ${step}`));

    addSection(doc, 'Macros');
    const macros = recipe.macros || {};
    addText(doc, `Protein: ${macros.protein || 'N/A'} | Fat: ${macros.fat || 'N/A'} | Carbs: ${macros.carbs || 'N/A'}`);
  });
}

export async function createPdfFromMealPlan(cache, type) {
  const doc = new PDFDocument({ margin: 44, size: 'LETTER' });
  const done = collectPdf(doc);

  if (type === 'mealplan') addMealPlan(doc, cache);
  else if (type === 'shopping-list') addShoppingList(doc, cache);
  else if (type === 'recipes') addRecipes(doc, cache);
  else throw new Error('Invalid type parameter.');

  doc.end();
  return done;
}

export async function uploadPdfToS3(buffer, filename) {
  if (!process.env.AWS_BUCKET_NAME) throw new Error('AWS_BUCKET_NAME is not set.');

  const bucketName = process.env.AWS_BUCKET_NAME;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: filename,
    Body: buffer,
    ContentType: 'application/pdf'
  }));

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucketName, Key: filename }),
    { expiresIn: 3600 }
  );

  return url;
}
