
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

function getWeekdays(startDay, count) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const startIndex = weekdays.indexOf(startDay);
  return Array.from({ length: count }, (_, i) => weekdays[(startIndex + i) % 7]);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const {
      name, email, duration, people, dietType, dietaryPreferences, meals,
      appliances, calories, protein, mealStyle, cookingRequests,
      budget, store, onHandIngredients, calendarInsights, feedback
    } = req.body;

    const today = new Date();
    const weekdayStart = getWeekdays(today.toLocaleString('en-US', { weekday: 'long' }), parseInt(duration || 7));

    const basePrompt = `
You are a meal planning assistant. Create a customized meal plan labeled by weekday (e.g., Monday, Tuesday...).
Use this data:
- Diet: ${dietType || 'any'}
- Meals requested: ${Array.isArray(meals) ? meals.join(', ') : meals}
- Daily Calories: ${calories || 'any'}
- Daily Protein: ${protein || 'any'}
- Number of People: ${people}
- Store: ${store}
- Budget: ${budget || 'unspecified'}
- Preferred Meal Style: ${mealStyle || 'any'}
- Dietary Restrictions: ${dietaryPreferences || 'none'}
- Appliances Available: ${Array.isArray(appliances) ? appliances.join(', ') : appliances}
- Ingredients On Hand: ${onHandIngredients || 'none'}
- Special Requests: ${cookingRequests || 'none'}

Schedule Notes: ${calendarInsights || 'none'}

Only use requested meals. On busy days (e.g., if calendarInsights mention activities like baseball or church), make meals simpler or prep-ahead (like crockpot, air fryer, or leftovers). Use the week starting on ${weekdayStart[0]} and show each day explicitly.

${feedback ? `The user also said they want these changes: ${feedback}` : ''}

Return the plan as:
Monday:
- Breakfast: ...
- Lunch: ...
- Supper: ...

Continue through the full week.`;

    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: basePrompt }],
      temperature: 0.7,
    });

    res.json({ mealPlan: chatResponse.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Meal plan generation failed' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
