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
console.log('[DEBUG] Express app created');
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_DIR = './cache';

const allowedOrigins = ['https://thechaostoconfidencecollective.com'];
console.log('[DEBUG] Configuring CORS');
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

console.log('[DEBUG] Applying body-parser middleware');
app.use(bodyParser.json({ limit: '5mb' }));

function weekdaySequence(startDay, duration) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const startIndex = weekdays.indexOf(startDay);
  return Array.from({ length: duration }, (_, i) => weekdays[(startIndex + i) % 7]);
}

function extractRelevantInsights(calendarInsights, startDay, duration) {
  const days = weekdaySequence(startDay, duration);
  const insights = calendarInsights.split(/[,]/).map(s => s.trim()).filter(Boolean);
  return insights.filter(line => days.some(day => line.toLowerCase().includes(day.toLowerCase()))).join(', ');
}

function stripFormatting(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

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

  const prompt = `You are a professional meal planner. Create a ${duration}-day meal plan that begins on ${startDay}. Each day should include: ${meals.join(', ')}.
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
- End with a shopping list that combines all ingredients and subtracts on-hand items.
- Calculate total ingredient quantities based on household size
- Use U.S. measurements (e.g., cups, oz, lbs)
- Group shopping list items by category (Produce, Meat, Dairy, etc.)
- Be specific about meats (e.g., ground beef, chicken thighs, sirloin) and quantities`;

  console.log('[MEALPLAN REQUEST]', data);

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
  const [mealPlanPart, shoppingListPart] = result.split(/(?=Shopping List)/i);

  console.log('[MEAL PLAN OK]');
  return {
    mealPlan: stripFormatting(mealPlanPart?.trim() || ''),
    shoppingList: stripFormatting(shoppingListPart?.trim() || 'Shopping list coming soon...')
  };
}


app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;
  const filePath = path.join(CACHE_DIR, `${sessionId}.json`);

  try {
    const cache = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    let content = '';
    let filename = '';

    if (type === 'mealplan') {
      content = `Meal Plan for ${cache.name}

${cache.mealPlan}`;
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

    const buffer = await createPdfFromText(content, {
      type: type === 'shopping-list' ? 'shoppingList' : (type === 'recipes' ? 'columns' : undefined)
    });

    const url = await uploadPdfToS3(buffer, filename);
    res.json({ url });
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(404).json({ error: 'PDF or session not found.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


async function generateRecipes(data, mealPlan) {
  const { people = 4 } = data;

  const prompt = `You are a recipe writer. Based on the following meal plan, write full recipes for each meal.

Meal Plan:
${mealPlan}

Include:
- Title (include day and meal type)
- Ingredients listed clearly with accurate U.S. measurements and scaled for ${people} people
- Step-by-step cooking instructions
- Prep & cook time
- Macros per serving
- Use clear formatting
- Be specific about meat cuts (e.g., ground beef, chicken thighs, sirloin)
- Separate recipes with a line break, and make the title bold.`;

  console.log('[RECIPE GEN] Submitting to GPT...');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  const result = completion.choices?.[0]?.message?.content?.trim() || '';
  console.log('[RECIPE GEN] Output length:', result.length);
  console.log('[RECIPE GEN] Preview:', result.slice(0, 300));

  return result || '**No recipes could be generated based on the current meal plan.**';
}
