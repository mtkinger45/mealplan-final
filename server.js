// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const allowedOrigins = ['https://login.gosocialfox.com'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed from this origin'));
    }
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '5mb' }));

async function generateMealPlanWithGPT(data) {
  const prompt = `You are a professional meal planner. Based on the user's preferences below, create a ${data.duration || 7}-day meal plan. Each day should include: ${data.meals?.join(', ') || 'Supper'}.

User info:
Diet Type: ${data.dietType || 'Any'}
Preferences: ${data.dietaryPreferences || 'None'}
Cooking Style: ${data.mealStyle || 'Any'}
Requests: ${data.cookingRequests || 'None'}
Available Appliances: ${data.appliances?.join(', ') || 'None'}
Ingredients on hand: ${data.onHandIngredients || 'None'}
Schedule insights: ${data.calendarInsights || 'None'}

Please format the meal plan clearly using markdown. At the end, include a shopping list and detailed recipe summaries (with step-by-step instructions, US measurements, estimated prep time, cook time, and basic macros).`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 2500
  });

  const result = completion.choices[0].message.content;
  const [mealPlanPart, recipesPart, shoppingListPart] = result.split(/(?=Recipe|Shopping List)/i);

  return {
    mealPlan: mealPlanPart.trim(),
    recipes: (recipesPart || 'Recipes coming soon...').trim(),
    shoppingList: (shoppingListPart || 'Shopping list coming soon...').trim(),
  };
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const gptResult = await generateMealPlanWithGPT(data);
    res.json({
      mealPlan: gptResult.mealPlan,
      recipes: gptResult.recipes,
      shoppingList: gptResult.shoppingList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.post('/api/finalize', async (req, res) => {
  try {
    const { name = 'Guest', mealPlan, recipes, shoppingList } = req.body;
    if (!mealPlan || !recipes || !shoppingList) {
      return res.status(400).json({ error: 'Missing meal plan data.' });
    }

    const planPdfBuffer = await createPdfFromText(`Meal Plan for ${name}\n\n${mealPlan}`);
    const recipesPdfBuffer = await createPdfFromText(`Recipes for ${name}\n\n${recipes}`, { layout: 'columns' });
    const shoppingPdfBuffer = await createPdfFromText(`Shopping List for ${name}\n\n${shoppingList}`);

    const [planPdf, recipesPdf, shoppingPdf] = await Promise.all([
      uploadPdfToS3(planPdfBuffer, `${name}-plan.pdf`),
      uploadPdfToS3(recipesPdfBuffer, `${name}-recipes.pdf`),
      uploadPdfToS3(shoppingPdfBuffer, `${name}-shopping.pdf`)
    ]);

    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    console.error('Error in /api/finalize:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate PDFs.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
