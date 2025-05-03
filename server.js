import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText } from './pdfUtils.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

app.post('/api/mealplan', async (req, res) => {
  const { name, meals, duration, calendarInsights } = req.body;

  // Simulated plan creation based on calendar
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const startDay = new Date().getDay();
  const plan = [];
  for (let i = 0; i < Number(duration || 7); i++) {
    const dayName = days[(startDay + i) % 7];
    const busy = calendarInsights?.toLowerCase().includes(dayName.toLowerCase());
    plan.push(`${dayName}: ${meals.includes('Supper') ? (busy ? 'Quick meal' : 'Balanced meal') : '—'}`);
  }
  res.json({ mealPlan: `Meal Plan for ${name}\n\n` + plan.join('\n') });
});

app.post('/api/finalize', async (req, res) => {
  const { name, mealPlan } = req.body;
  try {
    const planPdf = await createPdfFromText(`Meal Plan for ${name}\n\n${mealPlan}`);
    const recipesPdf = await createPdfFromText(`Recipes for ${name}\n\nRecipes coming soon...`);
    const shoppingPdf = await createPdfFromText(`Shopping List for ${name}\n\nList coming soon...`);

    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDFs' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
