// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_DIR = './cache';

app.use(cors({ origin: true }));
app.use(bodyParser.json({ limit: '5mb' }));

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();
    const { mealPlan, shoppingList, recipeInfoList } = await generateMealPlan(data);
    const recipes = await generateRecipesParallel(data, recipeInfoList);

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({
      name: data.name || 'Guest',
      mealPlan,
      shoppingList,
      recipes
    }, null, 2));

    res.json({ sessionId, mealPlan, shoppingList, recipes });
  } catch (err) {
    console.error('[API ERROR]', err);
    res.status(500).json({ error: 'Meal plan generation failed.' });
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;
  const filePath = path.join(CACHE_DIR, `${sessionId}.json`);

  try {
    const cache = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    let content = '';
    let filename = '';

    if (type === 'mealplan') {
      content = `Meal Plan for ${cache.name}\n\n${cache.mealPlan}`;
      filename = `${sessionId}-mealplan.pdf`;
    } else if (type === 'recipes') {
      content = cache.recipes;
      filename = `${sessionId}-recipes.pdf`;
    } else if (type === 'shopping-list') {
      content = cache.shoppingList;
      filename = `${sessionId}-shopping.pdf`;
    } else {
      return res.status(400).json({ error: 'Invalid type parameter.' });
    }

    const buffer = await createPdfFromText(content, { type });
    const url = await uploadPdfToS3(buffer, filename);
    res.json({ url });
  } catch (err) {
    console.error('[PDF ERROR]', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mergeLines(lines) {
  const merged = {};
  lines.forEach(line => {
    const match = line.match(/^(.+?):\s*(.+)$/);
    if (match) {
      const key = normalizeKey(match[1]);
      const value = match[2];
      if (!merged[key]) merged[key] = { name: match[1], values: [] };
      merged[key].values.push(value);
    } else {
      const key = normalizeKey(line);
      if (!merged[key]) merged[key] = { name: line, values: [] };
    }
  });
  return Object.values(merged).map(entry => `${entry.name}${entry.values.length ? ': ' + entry.values.join(' + ') : ''}`);
}

async function generateMealPlan(data) {
  const {
    duration = 7,
    startDay = 'Monday',
    meals = ['Supper'],
    dietType = 'Any',
    dietaryPreferences = 'None',
    mealStyle = 'Any',
    cookingRequests = 'None',
    appliances = [],
    onHandIngredients = 'None',
    calendarInsights = 'None',
    people = 4,
    name = 'Guest'
  } = data;

  const prompt = `You are a professional meal planner. Create a ${duration}-day meal plan that begins on ${startDay}. Only include the following meals each day: ${meals.join(', ')}.
User Info:
- Diet Type: ${dietType}
- Preferences: ${dietaryPreferences}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Appliances: ${appliances.join(', ') || 'None'}
- On-hand Ingredients: ${onHandIngredients}
- Household size: ${people}
- Calendar Insights: ${calendarInsights || 'None'}

Instructions:
- Use ${startDay} as the first day
- Do NOT include any meal type not explicitly listed above
- End with a shopping list grouped by category and subtract on-hand items
- Include a JSON array of all meals with day, meal type, and title (for recipe lookup)`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 3000
  });

  const result = completion.choices?.[0]?.message?.content || '';
  const jsonMatch = result.match(/\[.*\]/s);
  let recipeInfoList = [];
  if (jsonMatch) {
    try {
      recipeInfoList = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[JSON PARSE ERROR]', e);
    }
  }

  const [mealPlanPart, shoppingListPartRaw] = result.split(/(?=Shopping List)/i);
  const shoppingListPart = shoppingListPartRaw?.replace(/Shopping List[:\n]*/i, '').trim() || '';

  const usedOnHand = [];
  const lines = shoppingListPart.split(/\n+/);
  const shoppingListCleaned = lines.map(line => {
    const normalized = line.toLowerCase();
    if (onHandIngredients && normalized) {
      const found = onHandIngredients.toLowerCase().split(',').some(h => normalized.includes(h.trim()));
      if (found) {
        usedOnHand.push(line);
        return `${line} (on-hand)`;
      }
    }
    return line;
  });

  const mergedList = mergeLines(shoppingListCleaned);
  const rebuiltShoppingList = `Shopping List\n\n` + mergedList.join('\n') +
    (usedOnHand.length ? `\n\nOn-hand Ingredients Used:\n${usedOnHand.join('\n')}` : '');

  return {
    mealPlan: mealPlanPart?.trim() || '',
    shoppingList: rebuiltShoppingList,
    recipeInfoList
  };
}

async function generateRecipesParallel(data, recipeInfoList) {
  if (!recipeInfoList.length) return '**No recipes could be generated based on the current meal plan.**';
  const { people = 4 } = data;

  const tasks = recipeInfoList.map(({ day, meal, title }) => {
    const prompt = `You are a professional recipe writer. Create a recipe with the following format.

**Meal Name:** ${day} ${meal} – ${title}
**Ingredients:**
- list each ingredient with quantity for ${people} people
**Instructions:**
1. step-by-step instructions
**Prep Time:** X minutes
**Macros:** Protein, Fat, Carbs`;

    return openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional recipe writer.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }).then(c => c.choices?.[0]?.message?.content?.trim() || '');
  });

  const outputs = await Promise.all(tasks);
  return outputs.join('\n\n---\n\n');
}
