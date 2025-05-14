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

try {
  console.log('[DEBUG] Entering route and server setup');

  async function generateRecipes(data, mealPlan) {
  console.log('[RECIPE GEN] Starting generation...');

    const { people = 4 } = data;
    const lines = mealPlan.split('\n').filter(l =>
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s(Breakfast|Lunch|Supper):/i.test(l.trim())
    );
    const recipes = [];

    for (const line of lines) {
      const match = line.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s(Breakfast|Lunch|Supper):\s*(.*)$/i);
      if (!match) continue;

      const [_, day, mealType, title] = match;
      const prompt = `You are a recipe writer. Write a full recipe for the following meal.

Meal Title: ${title}
Day: ${day}
Meal Type: ${mealType}
Servings: ${people}

Include:
- Ingredients listed clearly with accurate U.S. measurements for ${people} people
- Step-by-step cooking instructions
- Prep & cook time
- Macros per serving
- Format cleanly and label sections
- Use realistic, whole food ingredients`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a professional recipe writer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });console.log('[RECIPE RAW OUTPUT]', result?.slice(0, 500));
  return stripFormatting(result || '');console.log('[RECIPE RAW OUTPUT]', result?.slice(0, 500));
      if (result) {
        recipes.push(`**${day} ${mealType}: ${title}**\n${stripFormatting(result.trim())}\n`);
      } else {
        recipes.push(`**${day} ${mealType}: ${title}**\n⚠️ Recipe could not be generated.\n`);
      }
    }

    return recipes.join('\n\n---\n\n');
  }

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
- Add a note next to the day name if calendar insights are relevant
- Do NOT use "Day 1", use weekday names only
- Meals should be simple, realistic, and vary throughout the week
- Omit detailed ingredients and instructions in this view
- End with a shopping list that combines all ingredients and subtracts on-hand items
- Use U.S. measurements
- Group shopping list items by category`;

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

    if (!completion.choices || !completion.choices[0] || !completion.choices[0].message) {
      throw new Error('Invalid OpenAI response for meal plan');
    }

    const result = completion.choices[0].message.content;
    const [mealPlanPart, shoppingListPart] = result.split(/(?=Shopping List)/i);

    console.log('[MEAL PLAN OK]');
    return {
      mealPlan: stripFormatting(mealPlanPart?.trim() || ''),
      shoppingList: stripFormatting(shoppingListPart?.trim() || 'Shopping list coming soon...')
    };
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

      console.log('[RESPONSE OK]', { sessionId });
      res.json({
        sessionId,
        mealPlan: mealPlanData.mealPlan,
        shoppingList: mealPlanData.shoppingList,
        recipes
      });
    } catch (err) {
      console.error('[API ERROR]', err.message);
      res.status(500).json({ error: 'Error generating meal plan.' });
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
    console.log('[RECIPE PDF] Content length:', content?.length || 0);
    console.log('[RECIPE PDF] Preview:', content?.slice(0, 500));
        filename = `${sessionId}-recipes.pdf`;
      } else if (type === 'shopping-list') {
        content = cache.shoppingList;
        filename = `${sessionId}-shopping.pdf`;
      } else {
        return res.status(400).json({ error: 'Invalid type parameter.' });
      }

      const buffer = await createPdfFromText(content, {
        type: type === 'shopping-list' ? 'shoppingList' : undefined
      });

      const url = await uploadPdfToS3(buffer, filename);
      res.json({ url });
    } catch (err) {
      console.error('PDF generation error:', err);
      res.status(404).json({ error: 'PDF or session not found.' });
    }
  });

  console.log('[DEBUG] Preparing to bind port...');
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
} catch (err) {
  console.error('[❌ SETUP ERROR]', err);
}
