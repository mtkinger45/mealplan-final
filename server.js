
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs/promises';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function generateWeekdays(startDate, count) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const date = new Date(startDate);
  let results = [];
  for (let i = 0; i < count; i++) {
    results.push(days[(date.getDay() + i) % 7]);
  }
  return results;
}

async function generatePdf(title, contentArray, filename) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 50;

  let y = height - margin;
  page.drawText(title, { x: margin, y, size: 18, font });
  y -= 30;

  for (const line of contentArray) {
    const wrapped = line.match(/.{1,90}/g) || [];
    for (const sub of wrapped) {
      if (y < 50) {
        y = height - margin;
        pdfDoc.addPage();
      }
      page.drawText(sub, { x: margin, y, size: fontSize, font });
      y -= 18;
    }
    y -= 12;
  }

  const pdfBytes = await pdfDoc.save();
  const path = `/tmp/${filename}`;
  await fs.writeFile(path, pdfBytes);
  return path;
}

app.post('/api/finalize', async (req, res) => {
  const { name, mealPlan, onHandIngredients, people } = req.body;

  const planText = `Meal Plan for ${name}

${mealPlan}`;
  const recipes = mealPlan.split('\n')
    .filter(line => line.includes(':'))
    .map(line => `Recipe for ${line.split(':')[1].trim()}:
- Ingredient 1
- Ingredient 2
- Steps: Cook and enjoy.`);

  const shoppingList = [
    'Shopping List:',
    '- Item 1',
    '- Item 2',
    '(Adjusted for people: ' + (people || 1) + ')'
  ];

  const planPdf = await generatePdf('Meal Plan', planText.split('\n'), 'plan.pdf');
  const recipesPdf = await generatePdf('Recipes', recipes, 'recipes.pdf');
  const shoppingPdf = await generatePdf('Shopping List', shoppingList, 'shopping.pdf');

  res.json({
    planPdf: `https://mealplan-final.onrender.com/static/plan.pdf`,
    recipesPdf: `https://mealplan-final.onrender.com/static/recipes.pdf`,
    shoppingPdf: `https://mealplan-final.onrender.com/static/shopping.pdf`
  });
});

app.listen(port, () => console.log(`Meal Plan API listening on port ${port}`));
