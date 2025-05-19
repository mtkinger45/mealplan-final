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

// FIXED: Explicit CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://thechaostoconfidencecollective.com');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(bodyParser.json({ limit: '5mb' }));

function stripFormatting(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/ribeye.*|steaks?.*|beef.*steak/, 'ribeye steak')
    .replace(/onions?.*|chopped onion.*/, 'onion')
    .replace(/garlic.*|minced garlic/, 'garlic')
    .replace(/butter.*|unsalted butter|salted butter|melted butter/, 'butter')
    .replace(/eggs?.*|beaten eggs/, 'eggs')
    .replace(/(pieces|cups|slices|cloves|oz|lbs|tablespoons|tablespoon|tbsp|tsp|teaspoons|teaspoon)/gi, '')
    .replace(/[^a-zA-Z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAndParseIngredient(line) {
  const clean = line.toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-zA-Z0-9\s.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const match = clean.match(/^(\d+(?:\.\d+)?)(?:\s+)?([a-zA-Z]+)?\s+(.*)$/);
  if (!match) return null;

  const [, qtyStr, unitRaw, nameRaw] = match;
  const qty = parseFloat(qtyStr);
  const unit = (unitRaw || '').toLowerCase();
  const name = normalizeName(nameRaw);

  return { name, qty, unit };
}

function parseOnHandMap(text) {
  const map = {};
  const lines = text.split(/\n|,/);
  for (const line of lines) {
    const parsed = normalizeAndParseIngredient(line.trim());
    if (parsed) {
      const key = parsed.name + '|' + parsed.unit;
      map[key] = (map[key] || 0) + parsed.qty;
    }
  }
  return map;
}
function categorizeIngredient(name) {
  const i = name.toLowerCase();
  if (/lemon|lime|avocado|zucchini|tomato|onion|garlic|pepper|mushroom|cucumber|carrot|broccoli|spinach|lettuce|peas|green beans|asparagus|cabbage|cauliflower/.test(i)) return 'Produce';
  if (/beef|chicken|turkey|bacon|steak|pork|fish|ribeye/.test(i)) return 'Meat';
  if (/milk|cheese|egg|butter|cream|yogurt/.test(i)) return 'Dairy';
  if (/oil|vinegar|sugar|flour|baking|yeast|spice|salt|pepper|herb|cornstarch|broth|syrup/.test(i)) return 'Pantry';
  return 'Other';
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

${allergyWarning}

Instructions:
- Use ${startDay} as the first day
- Respect all dietary preferences
- End with a shopping list
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

    const recipeBlocks = await Promise.all(tasks);
    const recipesByDay = recipeInfoList.map((entry, idx) => ({
      ...entry,
      fullText: recipeBlocks[idx]
    }));

    const recipes = recipesByDay.map(r =>
      `**Meal Name:** ${r.day} ${r.meal} – ${r.title}\n${r.fullText}`
    ).join('\n\n---\n\n');

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

    const onHandMap = parseOnHandMap(onHandIngredients);
    const grouped = {};

    for (const line of rawIngredients) {
      const parsed = normalizeAndParseIngredient(line);
      if (!parsed || isNaN(parsed.qty)) continue;
      const key = parsed.name;
      const fullKey = parsed.name + '|' + parsed.unit;
      const available = onHandMap[fullKey] || 0;
      const needed = Math.max(parsed.qty - available, 0);
      if (needed === 0) continue;
      if (!grouped[key]) grouped[key] = {};
      if (!grouped[key][parsed.unit]) grouped[key][parsed.unit] = 0;
      grouped[key][parsed.unit] += needed;
    }

    // 🗂️ Format by category
    const categorized = {};
    for (const name of Object.keys(grouped)) {
      const cat = categorizeIngredient(name);
      if (!categorized[cat]) categorized[cat] = {};
      categorized[cat][name] = grouped[name];
    }

    const lines = [];
    for (const cat of Object.keys(categorized).sort()) {
      lines.push(`\n<b>${cat}</b>`);
      const ingredients = categorized[cat];
      for (const name of Object.keys(ingredients).sort()) {
        lines.push(`${name.charAt(0).toUpperCase() + name.slice(1)}:`);
        for (const unit of Object.keys(ingredients[name])) {
          const qty = ingredients[name][unit];
          lines.push(`• ${qty}${unit ? ' ' + unit : ''}`);
        }
      }
    }

    const rebuiltShoppingList = lines.join('\n');
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({
      name: data.name || 'Guest',
      mealPlan: stripFormatting(mealPlanPart.trim()),
      shoppingList: rebuiltShoppingList.trim(),
      recipes
    }, null, 2));

    res.json({
      sessionId,
      mealPlan: stripFormatting(mealPlanPart.trim()),
      shoppingList: rebuiltShoppingList.trim(),
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
