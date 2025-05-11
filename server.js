// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const allowedOrigins = ['https://thechaostoconfidencecollective.com'];

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

function stripHtmlAndAsterisks(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

async function generateMealPlanAndShoppingList(data) {
  const prompt = `You are a professional meal planner. Based on the user's preferences below, create a ${data.duration || 7}-day meal plan. Each day should include: ${data.meals?.join(', ') || 'Supper'}.

User info:
- Diet Type: ${data.dietType}
- Preferences: ${data.dietaryPreferences}
- Cooking Style: ${data.mealStyle}
- Special Requests: ${data.cookingRequests}
- Available Appliances: ${data.appliances?.join(', ') || 'None'}
- Ingredients on hand: ${data.onHandIngredients}
- Schedule insights: ${data.calendarInsights}
- Household size: ${data.people || 4}

Note: Format clearly. Use weekday names if possible, and group meals logically. Remove extra formatting characters.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  const result = completion.choices[0].message.content;
  const [mealPlanPart, shoppingListPart] = result.split(/(?=Shopping List)/i);
  return {
    mealPlan: stripHtmlAndAsterisks(mealPlanPart?.trim() || ''),
    shoppingList: stripHtmlAndAsterisks(shoppingListPart?.trim() || '')
  };
}

async function generateRecipes(data, mealPlan) {
  const prompt = `You are a recipe developer. Based on the following meal plan, write complete recipes for each meal. Include:
- Meal Type (e.g., Breakfast, Lunch, Supper)
- Title (bold or easily scannable)
- Ingredients (one per line, using U.S. measurements like cups, tbsp, tsp, oz, lbs, and specify exact meat types like ground beef, sirloin, chicken breast, pork loin, etc. Scale quantities for ${data.people || 4} people.)
- Instructions
- Prep & Cook time
- Macros per serving
Remove asterisks and format clearly.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a recipe expert.' },
      { role: 'user', content: `${prompt}\n\n${mealPlan}` }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  return stripHtmlAndAsterisks(completion.choices[0].message.content);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();
    const mealData = await generateMealPlanAndShoppingList(data);
    const recipes = await generateRecipes(data, mealData.mealPlan);

    const planPdfBuffer = await createPdfFromText(`Meal Plan for ${data.name || 'Guest'}\n\n${mealData.mealPlan}`);
    const recipesPdfBuffer = await createPdfFromText(`Recipes for ${data.name || 'Guest'}\n\n${recipes}`, { type: 'recipes' });
    const shoppingPdfBuffer = await createPdfFromText(`Shopping List for ${data.name || 'Guest'}\n\n${mealData.shoppingList}`, { type: 'shoppingList' });

    await uploadPdfToS3(planPdfBuffer, `${sessionId}-mealplan.pdf`);
    await uploadPdfToS3(recipesPdfBuffer, `${sessionId}-recipes.pdf`);
    await uploadPdfToS3(shoppingPdfBuffer, `${sessionId}-shopping-list.pdf`);

    res.json({
      sessionId,
      mealPlan: mealData.mealPlan,
      recipes,
      shoppingList: mealData.shoppingList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;

  const suffix = {
    'mealplan': 'mealplan.pdf',
    'recipes': 'recipes.pdf',
    'shopping-list': 'shopping-list.pdf'
  }[type];

  if (!suffix) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  const Key = `${sessionId}-${suffix}`;
  const command = new GetObjectCommand({ Bucket: process.env.AWS_BUCKET_NAME, Key });

  try {
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ url });
  } catch (err) {
    console.error('[PDF Fetch Error]', err);
    res.status(404).json({ error: 'PDF not found' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
