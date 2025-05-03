import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  try {
    const { feedback, ...userData } = req.body;

    const prompt = feedback
      ? `Update this meal plan based on the user's feedback.

User feedback: ${feedback}

Original Request:
${JSON.stringify(userData, null, 2)}`
      : `Create a personalized meal plan based on the user's input:
${JSON.stringify(userData, null, 2)}`;

    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a meal planning assistant.' },
        { role: 'user', content: prompt }
      ]
    });

    const mealPlan = chat.choices[0].message.content;
    res.json({ mealPlan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Meal plan generation failed' });
  }
});

async function generatePdf(content, title) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const textWidth = font.widthOfTextAtSize(content, fontSize);

  const lines = content.match(/.{1,90}/g) || [content];
  let y = height - 50;

  page.drawText(`${title}`, { x: 50, y, size: 16, font });
  y -= 30;

  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: fontSize, font });
    y -= 20;
  }

  const pdfBytes = await pdfDoc.save();

  const uploadRes = await fetch('https://file.io/?expires=1d', {
    method: 'POST',
    body: pdfBytes,
    headers: { 'Content-Type': 'application/pdf' },
  });

  const uploadJson = await uploadRes.json();
  return uploadJson.link || null;
}

app.post('/api/finalize', async (req, res) => {
  try {
    const { name, mealPlan } = req.body;
    const recipes = `Recipes for ${name}\n\n${mealPlan?.split('Day').slice(0, 2).join('Day') || 'Recipes coming soon...'}`;
    const shopping = `Shopping list based on meal plan\n\n${mealPlan?.split('\n').slice(0, 10).join('\n') || 'List coming soon...'}`;

    const planPdf = await generatePdf(mealPlan, `Meal Plan for ${name}`);
    const recipesPdf = await generatePdf(recipes, `Recipes for ${name}`);
    const shoppingPdf = await generatePdf(shopping, `Shopping List for ${name}`);

    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

app.listen(port, () => {
  console.log(`Meal Plan API listening at http://localhost:${port}`);
});
