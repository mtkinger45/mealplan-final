
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  const data = req.body;

  const mealTypes = Array.isArray(data.meals) ? data.meals.join(', ') : data.meals || 'Breakfast, Lunch, and Supper';
  const appliances = Array.isArray(data.appliances) ? data.appliances.join(', ') : data.appliances || 'any';
  const feedbackInstruction = data.feedback ? `Please revise the meal plan based on this feedback: ${data.feedback}. Do not include any ingredients or meals mentioned as unwanted.` : '';

  const prompt = `
You are a helpful meal planner AI. Create a ${data.duration || '7'}-day meal plan for a household of ${data.people || '4'} people following a ${data.dietType || 'standard'} diet.

Only include the following meals each day: ${mealTypes}.
Daily calorie goal: ${data.calories || 'flexible'}.
Protein goal: ${data.protein || 'not specified'} grams.
Avoid these dietary ingredients or allergens: ${data.dietaryPreferences || 'none'}.
Meal style preference: ${data.mealStyle || 'none'}.
Use only these appliances: ${appliances}.
Special requests: ${data.cookingRequests || 'none'}.
Budget: ${data.budget || 'not specified'} and preferred store: ${data.store || 'any'}.
These ingredients are already in their kitchen: ${data.onHandIngredients || 'none'}.
Their weekly schedule is: ${data.calendarInsights || 'not specified'}.
${feedbackInstruction}
Format the meal plan clearly by day and meal.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const mealPlan = completion.choices[0]?.message?.content;
    res.json({ mealPlan });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Meal plan generation failed" });
  }
});

app.post('/api/finalize', async (req, res) => {
  const { formData, mealPlan } = req.body;

  const prompt = (type) => `
Generate a detailed ${type} for the following meal plan. 
Scale recipes and ingredients for ${formData.people || '4'} people. 
Exclude ingredients they already have: ${formData.onHandIngredients || 'none'}.
Ensure consistency with these selected meals: ${formData.meals?.join(', ') || 'all'}.

Meal Plan:
${mealPlan}
`;

  try {
    const mealPdf = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt('meal plan summary') }],
      temperature: 0.7,
      max_tokens: 1500,
    });

    const recipesPdf = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt('recipes') }],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const shoppingPdf = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt('shopping list') }],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const createPdf = async (text, filename) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage();
      page.drawText(text.substring(0, 4000)); // trim overflow
      const pdfBytes = await doc.save();
      const filePath = path.join(__dirname, 'public', filename);
      fs.writeFileSync(filePath, pdfBytes);
      return `/public/${filename}`;
    };

    const planPdf = await createPdf(mealPdf.choices[0].message.content, 'plan.pdf');
    const recipes = await createPdf(recipesPdf.choices[0].message.content, 'recipes.pdf');
    const shopping = await createPdf(shoppingPdf.choices[0].message.content, 'shopping.pdf');

    res.json({
      planPdf,
      recipesPdf: recipes,
      shoppingPdf: shopping
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

app.use('/public', express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
