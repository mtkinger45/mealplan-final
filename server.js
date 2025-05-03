
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  try {
    const prompt = `
You are MealPlanGPT. Create a customized meal plan based on the following user input:

- Diet: ${req.body.dietType}
- Meals per day: ${req.body.meals?.join(', ') || 'not specified'}
- Daily Calories: ${req.body.calories || 'not specified'}
- Daily Protein: ${req.body.protein || 'not specified'}
- People to feed: ${req.body.people}
- Days: ${req.body.duration}
- Dietary restrictions: ${req.body.dietaryPreferences}
- Preferred meal style: ${req.body.mealStyle}
- Cooking requests: ${req.body.cookingRequests}
- Appliances: ${req.body.appliances?.join(', ') || 'not specified'}
- Calendar insights: ${req.body.calendarInsights || 'none'}
- Store: ${req.body.store || 'none'}

Create a ${req.body.duration || 7}-day meal plan using ONLY the selected meal types (${req.body.meals?.join(', ') || 'all meals'}). Match easier meals to busy days if calendar insights are given. Only use preferred ingredients and avoid restricted items.

List each day with the WEEKDAY NAME (starting from today) and list only the selected meals.

Format:
Monday:
- Breakfast: ...
- Lunch: ...
- Supper: ...

Respond with just the formatted meal plan.
    `;

    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    res.json({ mealPlan: chat.choices[0].message.content.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Meal plan generation failed' });
  }
});

async function generatePdfBase64(title, contentArray) {
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
        page = pdfDoc.addPage();
      }
      page.drawText(sub, { x: margin, y, size: fontSize, font });
      y -= 18;
    }
    y -= 12;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString('base64');
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
    `(Adjusted for ${people || 1} people)`
  ];

  const planPdfBase64 = await generatePdfBase64('Meal Plan', planText.split('\n'));
  const recipesPdfBase64 = await generatePdfBase64('Recipes', recipes);
  const shoppingPdfBase64 = await generatePdfBase64('Shopping List', shoppingList);

  res.json({
    planPdfBase64,
    recipesPdfBase64,
    shoppingPdfBase64
  });
});

app.listen(port, () => console.log(`Meal Plan API listening on port ${port}`));
