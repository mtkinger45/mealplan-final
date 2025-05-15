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
app.options('/api/mealplan', cors());
app.options('/api/pdf/:sessionId', cors());

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
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.options('*', cors());
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

  const prompt = `You are a professional meal planner. Create a ${duration}-day meal plan that begins on ${startDay}. Only include the following meals each day: ${meals.join(', ')}.
Do not include any other meals (e.g., skip Supper if it's not listed).

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
- Do NOT include meals not requested by user
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

async function generateRecipes(data, mealPlan) {
  const { people = 4 } = data;
  const lines = mealPlan.split('\n').filter(l => /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\s–-]+(Breakfast|Lunch|Supper):/i.test(l.trim()));
  const recipes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\s–-]+(Breakfast|Lunch|Supper):\s*(.*)$/i);
    if (!match) continue;

    const [_, day, mealType, title] = match;
    const prompt = `You are a recipe writer. Write a recipe using the format below for ${people} people.

**Meal ${i + 1} Name:** ${title}
**Ingredients:** List each ingredient with exact U.S. quantities.
**Instructions:** List steps clearly, numbered.
**Prep & Cook Time:** Estimated time.
**Macros per Serving:** Include protein, carbs, fat.`;

    console.log(`[GPT REQUEST] ${day} ${mealType}: ${title}`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional recipe writer.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const recipe = completion.choices?.[0]?.message?.content?.trim();
    if (recipe) {
      recipes.push(recipe);
    } else {
      recipes.push(`**Meal ${i + 1} Name:** ${title}\n⚠️ Failed to generate.`);
    }
  }

  if (recipes.length === 0) {
    return '**No recipes could be generated based on the current meal plan.**';
  }

  return recipes.join('\n\n---\n\n');
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();
    const mealPlanData = await generateMealPlanData(data);
    const recipes = await generateRecipes(data, mealPlanData.mealPlan);

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({
      name: data.name || 'Guest',
      ...mealPlanData,
      recipes
    }, null, 2));

    res.json({ sessionId, ...mealPlanData, recipes });
  } catch (err) {
    console.error('[API ERROR]', err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.get('/api/pdf/:sessionId', cors(), async (req, res) => {
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

    const buffer = await createPdfFromText(content, {
      type: type === 'shopping-list' ? 'shoppingList' : (type === 'recipes' ? 'recipes' : undefined)
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
