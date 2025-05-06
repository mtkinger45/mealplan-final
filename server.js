// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';

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

function stripHtmlAndAsterisks(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
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

  const feedbackText = feedback ? `NOTE: The user has requested this revision: "${feedback}". Please revise the new meal plan accordingly.` : '';

  const prompt = `You are a professional meal planner. Based on the user's preferences, create a ${duration}-day meal plan. Each day should include the following meals: ${meals.join(', ')}.

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

🔁 Please:
- Use weekday names (Monday–Sunday) in order, not 'Day 1', 'Day 2'.
- Match QUICK meals on busy days (based on the user's calendar).
- Avoid ingredients the user dislikes.
- Make sure formatting is clear and the plan ends with a "Shopping List"

🛒 For the "Shopping List":
- Combine ingredient quantities across all meals.
- Use clear US measurements (cups, oz, tbsp, tsp, lbs).
- Group ingredients by category (e.g., Produce, Dairy, Meat, Freezer, Pantry, Spices, Other).
- Omit items that the user already has listed under "Ingredients on hand".
- Do NOT prefix with dashes (-) or asterisks (*). Just use clean bullet points.`;

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
    mealPlan: stripHtmlAndAsterisks(mealPlanPart?.trim() || ''),
    shoppingList: stripHtmlAndAsterisks(shoppingListPart?.trim() || 'Shopping list coming soon...')
  };
}

async function generateRecipes(data, mealPlan) {
  const { householdSize = 4 } = data;

  const prompt = `You are a recipe developer. Based on the following meal plan, write complete recipes for each meal.

Meal Plan:
${mealPlan}

Each recipe should include:
- Title (bold)
- Ingredients in list format with US quantities adjusted for ${householdSize} servings
- Step-by-step instructions
- Prep time, cook time, and macros per serving.
- Make sure all meals have a recipe and do not use placeholders like '(continue...)'.
- Remove asterisks around titles and return clean text.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  });

  return stripHtmlAndAsterisks(completion.choices[0].message.content);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const gptResult = await generateMealPlanAndShoppingList(data);
    const recipes = await generateRecipes(data, gptResult.mealPlan);

    res.json({
      mealPlan: gptResult.mealPlan,
      shoppingList: gptResult.shoppingList,
      recipes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.post('/api/pdf/mealplan', async (req, res) => {
  try {
    const { name = 'Guest', mealPlan } = req.body;
    const planPdfBuffer = await createPdfFromText(`Meal Plan for ${name}

${mealPlan}`);
    const planPdf = await uploadPdfToS3(planPdfBuffer, `${name}-plan.pdf`);
    res.json({ planPdf });
  } catch (err) {
    console.error('Error generating meal plan PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate meal plan PDF.' });
  }
});

app.post('/api/pdf/recipes', async (req, res) => {
  try {
    const { name = 'Guest', recipes } = req.body;
    const recipesPdfBuffer = await createPdfFromText(`Recipes for ${name}

${recipes}`, { layout: 'columns' });
    const recipesPdf = await uploadPdfToS3(recipesPdfBuffer, `${name}-recipes.pdf`);
    res.json({ recipesPdf });
  } catch (err) {
    console.error('Error generating recipes PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate recipes PDF.' });
  }
});

app.post('/api/pdf/shopping-list', async (req, res) => {
  try {
    const { name = 'Guest', shoppingList } = req.body;
    const shoppingPdfBuffer = await createPdfFromText(`Shopping List for ${name}

${shoppingList}`, { type: 'shoppingList' });
    const shoppingPdf = await uploadPdfToS3(shoppingPdfBuffer, `${name}-shopping.pdf`);
    res.json({ shoppingPdf });
  } catch (err) {
    console.error('Error generating shopping list PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate shopping list PDF.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
