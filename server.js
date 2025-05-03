import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText } from './pdf.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// Replace this with real GPT logic later
function mockMealPlanAI(data) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const totalDays = parseInt(data.duration || 7);
  const selectedMeals = data.meals || ['Supper'];
  let meals = [];

  for (let i = 0; i < totalDays; i++) {
    const day = weekdays[i % 7];
    selectedMeals.forEach(mealType => {
      meals.push(`${day} ${mealType}: Example meal for ${mealType}`);
    });
  }

  return {
    mealPlan: meals.join('\n'),
    recipes: 'Recipe 1: Ingredients...\nRecipe 2: Instructions...\n',
    shoppingList: 'Eggs\nBeef\nBroccoli\nSweet Potatoes\n',
  };
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const gptResult = mockMealPlanAI(data);
    res.json({ mealPlan: gptResult.mealPlan });
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

    const planPdf = await createPdfFromText(`Meal Plan for ${name}\n\n${mealPlan}`);
    const recipesPdf = await createPdfFromText(`Recipes for ${name}\n\n${recipes}`);
    const shoppingPdf = await createPdfFromText(`Shopping List for ${name}\n\n${shoppingList}`);

    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    console.error('Error in /api/finalize:', err);
    res.status(500).json({ error: 'Failed to generate PDFs.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
