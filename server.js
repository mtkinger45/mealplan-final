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
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed from this origin'));
    }
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '5mb' }));

function weekdaySequence(startDay, duration) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const startIndex = weekdays.indexOf(startDay);
  return Array.from({ length: duration }, (_, i) => weekdays[(startIndex + i) % 7]);
}

function extractRelevantInsights(insights, startDay, duration) {
  const days = weekdaySequence(startDay, duration);
  return insights
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => days.some(day => line.toLowerCase().includes(day.toLowerCase())))
    .join(', ');
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
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

Instructions:
- Use ${startDay} as the first day and follow correct weekday order
- Add a note next to the day name if calendar insights are relevant (e.g., Monday – Baseball night)
- Only include selected meals: ${meals.join(', ')}
- Omit ingredients and instructions
- End with a categorized shopping list with quantities
- Subtract on-hand ingredients from list
- Use U.S. measurements and be specific about meat cuts`;

    const mealCompletion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional meal planner.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    const result = mealCompletion.choices[0]?.message?.content || '';
    const [mealPlan, shoppingList] = result.split(/(?=Shopping List)/i);

    const lines = mealPlan.split('\n').filter(line =>
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s(Breakfast|Lunch|Supper):/i.test(line.trim())
    );

    const recipes = [];
    let mealNumber = 1;
    for (const line of lines) {
      const match = line.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s(Breakfast|Lunch|Supper):\s*(.*)$/i);
      if (!match) continue;
      const [_, day, type, title] = match;

      const recipePrompt = `You are a recipe writer. Write a full recipe for the following meal:
**Meal ${mealNumber} Name:** ${title}
**Ingredients:** (include measurements for ${people} people)
**Instructions:** Step-by-step
**Prep & Cook Time:**
**Macros:** per serving`;

      const recipeResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a professional recipe writer.' },
          { role: 'user', content: recipePrompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });

      const recipeText = recipeResponse.choices[0]?.message?.content?.trim();
      if (recipeText) {
        recipes.push(`**Meal ${mealNumber} Name:** ${title}\n${recipeText}\n---`);
      }

      mealNumber++;
    }

    const sessionId = randomUUID();
    const payload = {
      sessionId,
      name,
      mealPlan: mealPlan.trim(),
      shoppingList: shoppingList?.trim() || 'Shopping list coming soon...',
      recipes: recipes.length > 0 ? recipes.join('\n') : '**No recipes could be generated based on the current meal plan.**'
    };

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2));

    res.json(payload);
  } catch (err) {
    console.error('[MEALPLAN ERROR]', err);
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

    const buffer = await createPdfFromText(content, {
      type: type === 'shopping-list' ? 'shoppingList' : (type === 'recipes' ? 'recipes' : undefined)
    });

    const url = await uploadPdfToS3(buffer, filename);
    res.json({ url });
  } catch (err) {
    console.error('[PDF ERROR]', err);
    res.status(500).json({ error: 'PDF generation failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
