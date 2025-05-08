// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import OpenAI from 'openai';
import {
  createPdfFromText,
  uploadPdfToS3,
  generateSessionId,
  saveJsonToDisk,
  loadJsonFromDisk
} from './pdf.js';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const allowedOrigins = ['https://login.gosocialfox.com'];

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
  return text
    .replace(/<b>(.*?)<\/b>/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*/g, '');
}

async function generateMealPlanAndShoppingList(data) {
  const {
    duration = 7,
    meals = ['Supper'],
    dietType = 'Any',
    dietaryPreferences = 'None',
    mealStyle = 'Any',
    cookingRequests = 'None',
    appliances = [],
    onHandIngredients = 'None',
    calendarInsights = 'None',
    feedback = '',
    householdSize = 4
  } = data;

  const feedbackText = feedback ? `NOTE: The user has requested this revision: "${feedback}".` : '';

  const prompt = `You are a professional meal planner. Based on the user's preferences, create a ${duration}-day meal plan. Each day should include: ${meals.join(', ') || 'Supper'}.

User info:
- Diet Type: ${dietType}
- Preferences: ${dietaryPreferences}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Available Appliances: ${appliances.join(', ') || 'None'}
- Ingredients on hand: ${onHandIngredients}
- Schedule insights: ${calendarInsights}
- Household size: ${householdSize}

${feedbackText}

🔁 Requirements:
- Use weekday names (Monday–Sunday) in order, not 'Day 1', 'Day 2'.
- Match QUICK meals on busy days based on calendar insights.
- Avoid ingredients the user dislikes.
- Format clearly. End with a "Shopping List"

🛒 Shopping List:
- Combine ingredient quantities.
- Use US measurements (cups, oz, tbsp, tsp, lbs).
- Group ingredients by category.
- Remove items the user already has.
- Do NOT prefix with dashes or asterisks.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  const result = completion.choices[0].message.content;
  const [mealPlanPart, shoppingListPart] = result.split(/(?=Shopping List)/i);

  return {
    mealPlan: stripFormatting(mealPlanPart?.trim() || ''),
    shoppingList: stripFormatting(shoppingListPart?.trim() || 'Shopping list coming soon...')
  };
}

async function generateRecipes(data, mealPlan) {
  const { householdSize = 4 } = data;

  const prompt = `You are a recipe developer. Based on the following meal plan, write complete recipes for each meal.

Meal Plan:
${mealPlan}

Each recipe must include:
- Meal type (Breakfast, Lunch, or Supper)
- Title (bolded)
- Ingredients in a list (1 per line) with US quantities scaled to ${householdSize} servings
- Instructions (step-by-step with numbers on same line as instruction)
- Prep & Cook Time
- Macros (carbs, fat, protein)
- Do not use placeholders. Do not wrap titles in asterisks.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  return stripFormatting(completion.choices[0].message.content);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = generateSessionId();

    const gptResult = await generateMealPlanAndShoppingList(data);
    const recipes = await generateRecipes(data, gptResult.mealPlan);

    await saveJsonToDisk({ ...data, ...gptResult, recipes }, sessionId);

    res.json({
      sessionId,
      mealPlan: gptResult.mealPlan,
      shoppingList: gptResult.shoppingList,
      recipes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.post('/api/pdf/:type', async (req, res) => {
  try {
    const { sessionId, name = 'Guest' } = req.body;
    const { type } = req.params;

    const data = await loadJsonFromDisk(sessionId);
    if (!data) return res.status(404).json({ error: 'Session not found.' });

    let content;
    let options = {};
    if (type === 'mealplan') {
      content = `Meal Plan for ${name}\n\n${data.mealPlan}`;
    } else if (type === 'recipes') {
      content = `Recipes for ${name}\n\n${data.recipes}`;
      options.layout = 'columns';
    } else if (type === 'shopping-list') {
      content = `Shopping List for ${name}\n\n${data.shoppingList}`;
      options.type = 'shoppingList';
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const buffer = await createPdfFromText(content, options);
    const key = `${name}-${type}.pdf`;
    const url = await uploadPdfToS3(buffer, key);

    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
