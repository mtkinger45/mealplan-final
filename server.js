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
    .replace(/\b(of|and|into|thinly|sliced|chopped|grated|shredded|mediumsized|large|small|boneless|skinless|smoked|whole|fresh|cut|peeled|halved|zested|juiced)\b/g, '')
    .replace(/[^a-zA-Z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAndParseIngredient(line) {
  const clean = line.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-zA-Z0-9\s.]/g, '').replace(/\s+/g, ' ').trim();
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
    console.log('[REQUEST RECEIVED]', JSON.stringify(data, null, 2));

    const sessionId = randomUUID();
    const {
      duration = 7, startDay = 'Monday', meals = ['Supper'], dietType = 'Any', dietaryPreferences = 'None',
      mealStyle = 'Any', cookingRequests = 'None', appliances = [], onHandIngredients = '',
      calendarInsights = '', people = 4, name = 'Guest'
    } = data;

    const allergyWarning = dietaryPreferences.toLowerCase().includes('shellfish')
      ? '⚠️ User may be allergic to shellfish. DO NOT include shrimp, crab, lobster, clams, or shellfish.'
      : '';

    const planPrompt = `You are a professional meal planner. Create a ${duration}-day meal plan starting on ${startDay} using only these meals: ${meals.join(', ')}.
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
- Only output the meal plan with JSON array of {day, meal, title} and finish with a basic shopping list grouped by category.`;

    const mealPlanRes = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional meal planner.' },
        { role: 'user', content: planPrompt }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    const result = mealPlanRes.choices?.[0]?.message?.content || '';
    console.log('[RAW GPT PLAN OUTPUT]', result.slice(0, 500));

    const [mealPlanPart] = result.split(/(?=Shopping List)/i);
    const jsonMatch = result.match(/\[.*\]/s);
    let recipeInfoList = [];

    if (jsonMatch) {
      try {
        recipeInfoList = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('[JSON PARSE ERROR]', e.message, '\nRaw JSON:', jsonMatch[0]);
        return res.status(500).json({ error: 'Failed to parse meal plan JSON from GPT.' });
      }
    }

    if (!recipeInfoList.length) {
      console.error('[NO RECIPES FOUND]');
      return res.status(500).json({ error: 'Meal plan returned empty or malformed JSON array.' });
    }

    const tasks = recipeInfoList.map(({ day, meal, title }) => {
      const prompt = `You are a recipe writer. Generate a recipe:
**Meal Name:** ${day} ${meal} – ${title}
**Ingredients:** (for ${people} people, U.S. measurements)
- list each item like "1 cup broccoli"
**Instructions:** Steps
**Prep Time:** X minutes
**Macros:** Protein, Fat, Carbs`;
      return openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a recipe writer.' },
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
    console.log('[SHOPPING LIST]', rebuiltShoppingList.slice(0, 500));

    
    
    
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
