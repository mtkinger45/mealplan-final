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

app.use(cors({
  origin: 'https://thechaostoconfidencecollective.com',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));


app.use(bodyParser.json({ limit: '5mb' }));

function stripFormatting(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

// Ingredient parsing + cleaning
function normalizeAndParseIngredient(line) {
  const original = line.toLowerCase();
  const clean = original
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-zA-Z0-9\s.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const match = clean.match(/^(\d+(?:\.\d+)?)(?:\s+)?([a-zA-Z]+)?\s+(.*)$/);
  if (!match) return null;

  const [, qtyStr, unitRaw, nameRaw] = match;
  const qty = parseFloat(qtyStr);
  const unit = (unitRaw || '').toLowerCase();
  const name = nameRaw
    .replace(/approximately|about|each|medium|large|small|boneless|skinless|trimmed|cleaned|sliced|diced|ends|halved|zested|juiced|grilled|beaten|leftover|cut into.*|thickcut|for serving/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { name, qty, unit };
}

function parseOnHandMap(text) {
  const map = {};
  const lines = text.split(/\n|,/);
  for (const line of lines) {
    const parsed = normalizeAndParseIngredient(line.trim());
    if (parsed) {
      const key = parsed.name;
      map[key] = (map[key] || 0) + parsed.qty;
    }
  }
  return map;
}
app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();
    const {
      duration = 7, startDay = 'Monday', meals = ['Supper'], dietType = 'Any', dietaryPreferences = 'None',
      mealStyle = 'Any', cookingRequests = 'None', appliances = [], onHandIngredients = '',
      calendarInsights = '', people = 4, name = 'Guest'
    } = data;

    const allergyWarning = dietaryPreferences.toLowerCase().includes('shellfish')
      ? '⚠️ User may be allergic to shellfish. ABSOLUTELY DO NOT include shrimp, crab, lobster, clams, or shellfish of any kind.'
      : '';

    const prompt = `You are a professional meal planner. Create a ${duration}-day meal plan that begins on ${startDay}. Only include the following meals each day: ${meals.join(', ')}.
User Info:
- Diet Type: ${dietType}
- Preferences: ${dietaryPreferences}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Appliances: ${appliances.join(', ') || 'None'}
- On-hand Ingredients: ${onHandIngredients}
- Household size: ${people}
- Calendar Insights: ${calendarInsights}
Use this to adjust complexity. On busy days, prioritize:
• One-pan, slow cooker, or 30-minute meals
• Fewer ingredients
• No complicated techniques

${allergyWarning}

Instructions:
- Use ${startDay} as the first day
- Respect all dietary preferences
- End with a shopping list grouped by category and subtract on-hand items
- Include a JSON array of all meals with day, meal type, and title`;

    const mealPlanRes = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional meal planner.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    const result = mealPlanRes.choices?.[0]?.message?.content || '';
    const [mealPlanPart] = result.split(/(?=Shopping List)/i);
    const jsonMatch = result.match(/\[.*\]/s);
    let recipeInfoList = [];
    if (jsonMatch) {
      try { recipeInfoList = JSON.parse(jsonMatch[0]); } catch (e) { console.error('[JSON PARSE ERROR]', e); }
    }
    if (!recipeInfoList.length) throw new Error('Recipe list is empty — unable to generate meal plan.');

    const tasks = recipeInfoList.map(({ day, meal, title }) => {
      const prompt = `You are a professional recipe writer. Create a recipe with the following format.
**Meal Name:** ${day} ${meal} – ${title}
**Ingredients:**
- list each ingredient with quantity for ${people} people in U.S. measurements
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
    const recipes = outputs.join('\n\n---\n\n');

    const rawIngredients = [];
    const recipeSections = recipes.match(/\*\*Ingredients:\*\*[\s\S]*?(?=\*\*Instructions:|\*\*Prep Time|---|$)/g) || [];
    for (const block of recipeSections) {
      const lines = block.split('\n').slice(1);
      for (const line of lines) {
        const clean = line.replace(/^[-•]\s*/, '').trim();
        if (clean && !/to taste|optional/i.test(clean)) {
          rawIngredients.push(clean);
        }
      }
    }

    // Parse on-hand ingredients
    const onHandMap = parseOnHandMap(onHandIngredients);
    const merged = {};
    for (const line of rawIngredients) {
      const parsed = normalizeAndParseIngredient(line);
      if (!parsed || isNaN(parsed.qty)) continue;
      const key = parsed.name;
      const available = onHandMap[key] || 0;
      const needed = Math.max(parsed.qty - available, 0);

      if (!merged[key]) merged[key] = { name: key, qty: 0, unit: parsed.unit };
      merged[key].qty += needed;
    }

    const mergedListForGpt = Object.values(merged).map(item => {
      const qtyStr = item.unit ? `${item.qty} ${item.unit}` : `${item.qty}`;
      return `• ${qtyStr} ${item.name}`;
    }).join('\n');

    const cleanedShoppingRes = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional chef and meal planner.' },
        {
          role: 'user',
          content: `Here is a merged list of ingredients from multiple recipes. 
Please group them by category (e.g., Produce, Meat, Pantry), and make the list clean and readable.

${mergedListForGpt}`
        }
      ],
      temperature: 0.5,
      max_tokens: 1200
    });

    const cleanedShoppingList = cleanedShoppingRes.choices?.[0]?.message?.content?.trim() || 'No shopping list generated.';
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({
      name: data.name || 'Guest',
      mealPlan: stripFormatting(mealPlanPart.trim()),
      shoppingList: cleanedShoppingList,
      recipes
    }, null, 2));

    res.json({
      sessionId,
      mealPlan: stripFormatting(mealPlanPart.trim()),
      shoppingList: cleanedShoppingList,
      recipes
    });
  } catch (err) {
    console.error('[API ERROR]', err);
    res.status(500).json({ error: 'Meal plan generation failed.' });
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;
  const filePath = path.join('./cache', `${sessionId}.json`);
  try {
    const cache = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    let content = '', filename = '';
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
