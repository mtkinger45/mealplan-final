
// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import OpenAI from 'openai';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

async function generateMealPlanWithGPT(data) {
  let prompt = `You are a professional meal planner. Based on the user's preferences below, create a \${data.duration || 7}-day meal plan. Each day should include: \${data.meals?.join(', ') || 'Supper'}.

User info:
Diet Type: \${data.dietType || 'Any'}
Preferences: \${data.dietaryPreferences || 'None'}
Cooking Style: \${data.mealStyle || 'Any'}
Requests: \${data.cookingRequests || 'None'}
Available Appliances: \${data.appliances?.join(', ') || 'None'}
Ingredients on hand: \${data.onHandIngredients || 'None'}
Schedule insights: \${data.calendarInsights || 'None'}
Number of people: \${data.people || 'Not specified'}

Please format clearly with:
• Meal Plan section (Weekday names: Monday through Sunday, not 'Day 1/2'. Include note after day name if mentioned in Schedule Insights like "Sunday – Baseball Night")
• Recipe section (one recipe per meal, with ingredients + instructions, prep & cook time, and macros)
• Shopping List grouped by category with quantities.
Use US measurements.\`;

  if (data.feedback && data.previousMealPlan) {
    prompt += \`

📝 The user provided this feedback: "\${data.feedback}"
Please regenerate the plan using the original as context but adapt it to follow the feedback.
Original Meal Plan:
\${data.previousMealPlan}
\`;
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional meal planner.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 5000
  });

  const result = completion.choices[0].message.content;
  const [mealPlanPart, recipePart, shoppingListPart] = result.split(/(?=Recipe|Shopping List)/i);

  return {
    mealPlan: (mealPlanPart || 'Meal plan not generated.').trim(),
    recipes: (recipePart || 'Recipe section missing.').trim(),
    shoppingList: (shoppingListPart || 'Shopping list missing.').trim(),
  };
}

let latestPlan = {};

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    if (data.feedback && latestPlan.mealPlan) {
      data.previousMealPlan = latestPlan.mealPlan;
    }

    const gptResult = await generateMealPlanWithGPT(data);
    latestPlan = {
      name: data.name || 'Guest',
      ...gptResult
    };
    res.json(gptResult);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.get('/api/pdf/mealplan', async (req, res) => {
  try {
    const cleanedText = latestPlan.mealPlan
      .replace(/^\*\*Meal Plan\*\*
?/i, '')
      .replace(/^\*\*([^
]+?)\*\*/gm, (_, day) => `
<b>${day}</b>`) // Bold days
      .replace(/^\*\s*/gm, '') // Remove asterisk from meal lines
      .replace(/^-\s*/gm, ''); // Also remove dashes if any

    const pdf = await createPdfFromText(`Meal Plan for ${latestPlan.name}

${cleanedText}`);
    const url = await uploadPdfToS3(pdf, `${latestPlan.name}-plan.pdf`);
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate meal plan PDF.' });
  }
});

app.get('/api/pdf/recipes', async (req, res) => {
  try {
    const pdf = await createPdfFromText(latestPlan.recipes, { layout: 'columns' });
    const url = await uploadPdfToS3(pdf, `${latestPlan.name}-recipes.pdf`);
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate recipe PDF.' });
  }
});

app.get('/api/pdf/shopping-list', async (req, res) => {
  try {
    const pdf = await createPdfFromText(latestPlan.shoppingList, { type: 'shoppingList' });
    const url = await uploadPdfToS3(pdf, `${latestPlan.name}-shopping.pdf`);
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate shopping list PDF.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
