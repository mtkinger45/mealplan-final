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

function stripFormatting(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

function extractRelevantInsights(insights, startDay, duration) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const startIndex = weekdays.indexOf(startDay);
  const cycle = Array.from({ length: duration }, (_, i) => weekdays[(startIndex + i) % 7]);
  return insights.split(',').filter(i => cycle.some(day => i.toLowerCase().includes(day.toLowerCase()))).join(', ');
}

function parseIngredientsFromRecipes(text) {
  const ingredients = [];
  const matches = text.match(/\*\*Ingredients:\*\*[\s\S]*?(?=\*\*Instructions:|\*\*Prep Time|\*\*Macros|---|$)/g) || [];
  for (const block of matches) {
    const lines = block.split('\n').slice(1);
    for (const line of lines) {
      const clean = line.replace(/^[-•]\s*/, '').trim().toLowerCase();
      if (clean) ingredients.push(clean);
    }
  }
  return ingredients;
}

function normalizeIngredient(ingredient) {
  return ingredient
    .replace(/\(.*?\)/g, '')
    .replace(/\d+(\.\d+)?\s?(cups?|oz|tablespoons?|teaspoons?|cloves?|bunches?|heads?|slices?|pieces?|lbs?|grams?|kg|containers?|cans?|packs?)/g, '')
    .replace(/[^a-zA-Z\s]/g, '')
    .replace(/\b(?:fresh|large|medium|small|chopped|diced|minced|sliced|to taste|optional)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function condenseIngredients(ingredientList) {
  const tally = {};
  for (const item of ingredientList) {
    const base = normalizeIngredient(item);
    if (!tally[base]) tally[base] = 0;
    tally[base] += 1;
  }
  return Object.entries(tally).map(([name, qty]) => `${name.charAt(0).toUpperCase() + name.slice(1)}: ${qty}`);
}

function categorizeIngredient(ingredient) {
  const i = ingredient.toLowerCase();
  if (/beef|ribeye|sirloin|steak|ground/.test(i)) return 'Meat';
  if (/chicken|thigh|breast|drumstick/.test(i)) return 'Meat';
  if (/pork|bacon|sausage/.test(i)) return 'Meat';
  if (/fish|salmon|tilapia|cod|shrimp/.test(i)) return 'Meat';
  if (/egg/.test(i)) return 'Dairy';
  if (/milk|cream|cheese/.test(i)) return 'Dairy';
  if (/lettuce|spinach|zucchini|broccoli|onion|pepper|cucumber|radish|mushroom|cauliflower|tomato|peas|green beans|asparagus|cabbage/.test(i)) return 'Produce';
  if (/butter|ghee|oil|olive/.test(i)) return 'Pantry';
  if (/lemon|lime|avocado|olive/.test(i)) return 'Fruit';
  return 'Other';
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();
    const { mealPlan, shoppingList, recipeInfoList } = await generateMealPlanData(data);
    const recipes = await generateRecipesParallel(data, recipeInfoList);

    const rawIngredients = parseIngredientsFromRecipes(recipes);
    const condensedIngredients = condenseIngredients(rawIngredients);
    const onHand = data.onHandIngredients?.toLowerCase().split(/\n|,/) || [];
    const categorized = {};

    condensedIngredients.forEach(item => {
      const cat = categorizeIngredient(item);
      if (!categorized[cat]) categorized[cat] = [];
      const owned = onHand.some(own => item.toLowerCase().includes(own.trim()));
      const label = owned ? `${item} (on-hand)` : item;
      if (!categorized[cat].includes(label)) categorized[cat].push(label);
    });

    let rebuiltShoppingList = '';
    for (const [category, items] of Object.entries(categorized)) {
      rebuiltShoppingList += `${category}:\n`;
      for (const i of items) {
        rebuiltShoppingList += `• ${i}\n`;
      }
      rebuiltShoppingList += '\n';
    }

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({
      name: data.name || 'Guest',
      mealPlan,
      shoppingList: rebuiltShoppingList.trim(),
      recipes
    }, null, 2));

    res.json({ sessionId, mealPlan, shoppingList: rebuiltShoppingList.trim(), recipes });
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
