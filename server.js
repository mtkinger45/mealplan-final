
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { config } from 'dotenv';
import { OpenAI } from 'openai';

config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  const {
    dietType,
    calories,
    mealsPerDay,
    dietaryRestrictions = "None",
    favoriteFoods = "None provided",
    foodsToAvoid = "None provided",
    goal,
    duration,
  } = req.body;

  const prompt = `
You are MealPlanGPT, a helpful assistant that creates customized meal plans.

User Info:
- Diet Type: ${dietType}
- Daily Calories: ${calories}
- Meals Per Day: ${mealsPerDay}
- Dietary Restrictions: ${dietaryRestrictions}
- Favorite Foods: ${favoriteFoods}
- Foods to Avoid: ${foodsToAvoid}
- Goal: ${goal}
- Plan Duration: ${duration}

Create a complete meal plan with daily breakdowns for each meal.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ mealPlan: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Meal plan generation failed' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
