// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_DIR = './cache';

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// Ensure cache directory exists
await fs.mkdir(CACHE_DIR, { recursive: true });

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function rotateWeekdays(startDay) {
  const index = weekdays.findIndex(day => day.toLowerCase() === startDay.toLowerCase());
  return [...weekdays.slice(index), ...weekdays.slice(0, index)];
}

function stripHtmlAndAsterisks(text) {
  return text
    .replace(/<b>(.*?)<\/b>/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*/g, '')
    .trim();
}

async function generateContent(data) {
  const {
    name = 'Guest',
    duration = 7,
    meals = ['Supper'],
    dietType = 'Any',
    dietaryPreferences = 'None',
    mealStyle = 'Any',
    cookingRequests = 'None',
    appliances = [],
    onHandIngredients = 'None',
    calendarInsights = 'None',
    feedback = '',
    householdSize = 4,
    startDay = 'Monday'
  } = data;

  const feedbackText = feedback ? `NOTE: The user has requested this revision: "${feedback}".` : '';

  const rotatedDays = rotateWeekdays(startDay);

  const prompt = `You are a professional meal planner. Based on the user's preferences, create a ${duration}-day meal plan. Each day should include the following meals: ${meals.join(', ')}.

User info:
- Diet Type: ${dietType}
- Preferences: ${dietaryPreferences}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Available Appliances: ${appliances.join(', ') || 'None'}
- Ingredients on hand: ${onHandIngredients}
- Schedule insights: ${calendarInsights}
- Household size: ${householdSize}
- Start day: ${startDay}

${feedbackText}

🔁 Please:
- Use these weekday names in order: ${rotatedDays.join(', ')}
- Match QUICK meals on busy days (based on the user's calendar)
- Omit meals for skipped days
- Do NOT include ingredients or instructions in the meal plan
- Ensure the shopping list reflects combined ingredients with US measurements, grouped by category, minus on-hand items`;

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
    mealPlan: stripHtmlAndAsterisks(mealPlanPart || ''),
    shoppingList: stripHtmlAndAsterisks(shoppingListPart || 'Shopping list coming soon...')
  };
}

async function generateRecipes(data, mealPlan) {
  const { householdSize = 4 } = data;

  const prompt = `You are a recipe developer. Write recipes for the following meal plan:

${mealPlan}

Each recipe should include:
- Recipe name (bold)
- Ingredients (US measurements, scaled for ${householdSize} servings)
- Instructions (step-by-step)
- Prep and cook time
- Macros per serving
Make sure all meals are covered. Do not repeat or add placeholder text.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  return stripHtmlAndAsterisks(completion.choices[0].message.content);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = uuidv4();
    const { mealPlan, shoppingList } = await generateContent(data);
    const recipes = await generateRecipes(data, mealPlan);

    const sessionData = { id: sessionId, name: data.name || 'Guest', mealPlan, shoppingList, recipes };
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(sessionData, null, 2));

    res.json({ sessionId, mealPlan, shoppingList, recipes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating content.' });
  }
});

app.get('/api/pdf/:id', async (req, res) => {
  const { id } = req.params;
  const { type = 'mealplan' } = req.query;

  try {
    const cachePath = path.join(CACHE_DIR, `${id}.json`);
    const raw = await fs.readFile(cachePath, 'utf-8');
    const { name, mealPlan, recipes, shoppingList } = JSON.parse(raw);

    const contentMap = {
      mealplan: `Meal Plan for ${name}\n\n${mealPlan}`,
      recipes: `Recipes for ${name}\n\n${recipes}`,
      'shopping-list': `Shopping List for ${name}\n\n${shoppingList}`
    };

    const pdfBuffer = await createPdfFromText(contentMap[type] || '', { type });
    const pdfKey = `${id}-${type}.pdf`;
    const url = await uploadPdfToS3(pdfBuffer, pdfKey);

    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'Session not found or PDF failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
