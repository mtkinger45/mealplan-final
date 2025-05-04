// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Allow only your frontend origin
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

function formatBoldHeadings(text) {
  // Convert **text** or __text__ to bold HTML
  let formatted = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                      .replace(/__(.*?)__/g, '<b>$1</b>');

  // Only convert weekday lines to bold if they're not already inside <b> tags
  formatted = formatted.replace(
    /^(?!(<b>))\b(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b(?!(<\/b>))/gm,
    '<b>$2</b>'
  );

  return formatted;
}


async function generateMealPlanWithGPT(data) {
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
    feedback = ''
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

${feedbackText}

🔁 Please:
- Use weekday names (Monday–Sunday) in order, not 'Day 1', 'Day 2'.
- Match QUICK meals on busy days (based on the user's calendar).
- Avoid ingredients the user dislikes.
- Make sure formatting is clear and the plan ends with a "Shopping List" and then "Recipe Summaries".
- Instead of surrounding day headers with asterisks like **Monday**, use ALL CAPS formatting like MONDAY or a bold Markdown-style (e.g., __Monday__) if appropriate.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 2000
  });

  const result = completion.choices[0].message.content;
  const [mealPlanPart, shoppingListPart, recipesPart] = result.split(/(?=Shopping List|Recipe Summaries)/i);

  return {
    mealPlan: formatBoldHeadings(mealPlanPart?.trim() || ''),
    shoppingList: formatBoldHeadings(shoppingListPart?.trim() || 'Shopping list coming soon...'),
    recipes: formatBoldHeadings(recipesPart?.trim() || 'Recipes coming soon...')
  };
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const gptResult = await generateMealPlanWithGPT(data);
    res.json({
      mealPlan: gptResult.mealPlan,
      recipes: gptResult.recipes,
      shoppingList: gptResult.shoppingList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.post('/api/finalize', async (req, res) => {
  try {
    const { name = 'Guest', mealPlan, recipes, shoppingList } = req.body;
    if (!mealPlan || !recipes || !shoppingList) {
      return res.status(400).json({ error: 'Missing meal plan data.' });
    }

    const planPdfBuffer = await createPdfFromText(`Meal Plan for ${name}\n\n${mealPlan}`);
    const recipesPdfBuffer = await createPdfFromText(`Recipes for ${name}\n\n${recipes}`);
    const shoppingPdfBuffer = await createPdfFromText(`Shopping List for ${name}\n\n${shoppingList}`);

    const [planPdf, recipesPdf, shoppingPdf] = await Promise.all([
      uploadPdfToS3(planPdfBuffer, `${name}-plan.pdf`),
      uploadPdfToS3(recipesPdfBuffer, `${name}-recipes.pdf`),
      uploadPdfToS3(shoppingPdfBuffer, `${name}-shopping.pdf`)
    ]);

    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    console.error('Error in /api/finalize:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate PDFs.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
