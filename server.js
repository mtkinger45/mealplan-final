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

function categorizeIngredient(ingredient) {
  if (/beef|ribeye|sirloin|steak|ground/.test(ingredient)) return 'Meat';
  if (/chicken|thigh|breast|drumstick/.test(ingredient)) return 'Meat';
  if (/pork|bacon|sausage/.test(ingredient)) return 'Meat';
  if (/fish|salmon|tilapia|cod|shrimp/.test(ingredient)) return 'Meat';
  if (/egg/.test(ingredient)) return 'Dairy';
  if (/milk|cream|cheese/.test(ingredient)) return 'Dairy';
  if (/lettuce|spinach|zucchini|broccoli|onion|pepper|cucumber|radish|mushroom|cauliflower|tomato|peas|green beans|asparagus|cabbage/.test(ingredient)) return 'Produce';
  if (/butter|ghee|oil|olive/.test(ingredient)) return 'Pantry';
  if (/lemon|lime|avocado|olive/.test(ingredient)) return 'Fruit';
  return 'Other';
}

function condenseIngredients(ingredientList) {
  const map = new Map();
  for (const item of ingredientList) {
    const key = item.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ').trim();
    map.set(key, item);
  }
  return Array.from(map.values());
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
      const owned = onHand.some(own => item.includes(own.trim()));
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

async function generateMealPlanData(data) {
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
    feedback = '',
    people = 4,
    name = 'Guest'
  } = data;

  const cleanedInsights = extractRelevantInsights(calendarInsights, startDay, duration);
  const feedbackText = feedback ? `NOTE: The user has requested this revision: "${feedback}".` : '';

  const prompt = `You are a professional meal planner. Create a ${duration}-day meal plan that begins on ${startDay}. Only include the following meals each day: ${meals.join(', ')}.\nDo not include any other meals (e.g., skip Supper if it's not listed).
User Info:
- Diet Type: ${dietType}
- Preferences: ${dietaryPreferences}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Appliances: ${appliances.join(', ') || 'None'}
- On-hand Ingredients: ${onHandIngredients}
- Household size: ${people}
- Calendar Insights: ${cleanedInsights || 'None'}
${feedbackText}

Instructions:
- Use ${startDay} as the first day and follow correct weekday order
- Add a note next to the day name if calendar insights are relevant (e.g., Monday – Baseball night)
- Do NOT use "Day 1", use weekday names only
- Meals should be simple, realistic, and vary throughout the week
- Omit detailed ingredients and instructions in this view
- End with a shopping list labeled "Shopping List:" that combines all ingredients and subtracts on-hand items.
- Calculate total ingredient quantities based on household size
- Use U.S. measurements (e.g., cups, oz, lbs)
- Group shopping list items by category (Produce, Meat, Dairy, etc.)
- Be specific about meats (e.g., ground beef, chicken thighs, sirloin) and quantities
- Include "JSON Meals:" followed by a JSON array of all meals with day, meal type, and title (for recipe lookup)`;

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
  const [mealPlanPart, shoppingListBlock] = result.split(/Shopping List:/i);
  const [shoppingListPart] = shoppingListBlock?.split(/JSON Meals:/i) || [''];

  const jsonMatch = result.match(/\[.*\]/s);
  let recipeInfoList = [];
  if (jsonMatch) {
    try {
      recipeInfoList = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[JSON PARSE ERROR]', e);
    }
  }

  return {
    mealPlan: stripFormatting(mealPlanPart?.trim() || ''),
    shoppingList: stripFormatting(shoppingListPart?.trim() || ''),
    recipeInfoList
  };
}

async function generateRecipesParallel(data, recipeInfoList) {
  if (!recipeInfoList.length) return '**No recipes could be generated based on the current meal plan.**';
  const { people = 4 } = data;

  const tasks = recipeInfoList.map(({ day, meal, title }) => {
    const prompt = `You are a professional recipe writer. Create a recipe with the following format.\n\n**Meal Name:** ${day} ${meal} – ${title}\n**Ingredients:**\n- list each ingredient with quantity for ${people} people\n**Instructions:**\n1. step-by-step instructions\n**Prep Time:** X minutes\n**Macros:** Protein, Fat, Carbs`;

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
