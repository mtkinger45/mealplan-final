
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  const {
    name,
    email,
    duration,
    people,
    dietType,
    dietaryPreferences,
    meals,
    appliances,
    calories,
    protein,
    mealStyle,
    cookingRequests,
    budget,
    store,
    onHandIngredients,
    calendarInsights,
    feedback
  } = req.body;

  try {
    const prompt = `
You are a helpful meal planning assistant.

User info:
- Name: ${name}
- Diet: ${dietType || "no specific diet"}
- Duration: ${duration} days
- People: ${people}
- Meals wanted: ${meals?.join(', ')}
- Dietary preferences: ${dietaryPreferences || "none"}
- Daily calories: ${calories || "not specified"}
- Daily protein: ${protein || "not specified"}
- Appliances: ${appliances?.join(', ') || "none"}
- Preferred meal style: ${mealStyle || "none"}
- Cooking notes: ${cookingRequests || "none"}
- Grocery budget: ${budget || "not specified"}
- Store: ${store || "not specified"}
- Ingredients on hand: ${onHandIngredients || "none"}
- Weekly calendar: ${calendarInsights || "none"}
- Feedback from user: ${feedback || "none"}

Create a ${duration}-day meal plan with only the selected meals (${meals?.join(', ') || "all"}). Label the days with weekday names. For busy days from calendar insights, choose simpler/faster meals.

Reply ONLY with the meal plan, clearly formatted by weekday and meal. Do not include explanation text.`;

    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
    });

    const mealPlan = chat.choices[0].message.content;
    res.json({ mealPlan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Meal plan generation failed' });
  }
});

app.post('/api/finalize', async (req, res) => {
  const { name, mealPlan, people, onHandIngredients } = req.body;
  try {
    const recipePrompt = `
You are a recipe generator. The user is serving ${people} people.

Given the following meal plan:
${mealPlan}

Generate full recipes for each meal. Include ingredients and preparation steps. Scale ingredients for ${people} people.
`;

    const recipeResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: recipePrompt }],
    });
    const recipes = recipeResponse.choices[0].message.content;

    const shoppingPrompt = `
You are a smart grocery list assistant.

From these recipes:
${recipes}

Create a complete shopping list. Remove items the user already has: ${onHandIngredients || "none"}. Consolidate similar items and format the list cleanly.
`;

    const shoppingResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: shoppingPrompt }],
    });
    const shoppingList = shoppingResponse.choices[0].message.content;

    const pdfs = {
      planPdf: await generatePDF(`Meal Plan for ${name}`, mealPlan),
      recipesPdf: await generatePDF(`Recipes for ${name}`, recipes),
      shoppingPdf: await generatePDF(`Shopping List for ${name}`, shoppingList)
    };
    res.json(pdfs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

async function generatePDF(title, content) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const lines = content.split('\n');
  let y = height - 50;
  page.drawText(title, { x: 50, y, size: 16, font, color: rgb(0, 0, 0) });
  y -= 30;
  for (const line of lines) {
    if (y < 50) {
      page = pdfDoc.addPage();
      y = height - 50;
    }
    page.drawText(line, { x: 50, y, size: fontSize, font, color: rgb(0, 0, 0) });
    y -= 18;
  }

  const pdfBytes = await pdfDoc.save();
  const filePath = `/tmp/${title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
  fs.writeFileSync(filePath, pdfBytes);
  return `https://mealplan-final.onrender.com/static/${path.basename(filePath)}`;
}

app.use('/static', express.static('/tmp'));

app.listen(port, () => {
  console.log(`Meal plan API running on port ${port}`);
});
