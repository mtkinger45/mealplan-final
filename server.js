
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs/promises';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const formatPrompt = (data) => {
  return \`
You are a meal planning assistant.

Inputs:
- Diet Type: \${data.dietType || 'none'}
- Duration: \${data.duration} days
- Meals: \${data.meals?.join(', ') || 'not specified'}
- Dietary Preferences: \${data.dietaryPreferences || 'none'}
- On-hand Ingredients: \${data.onHandIngredients || 'none'}
- Appliances: \${data.appliances?.join(', ') || 'standard'}
- Daily Calorie Target: \${data.calories || 'not specified'}
- Protein Target: \${data.protein || 'not specified'}
- Budget: \${data.budget || 'not specified'}
- Meal Style: \${data.mealStyle || 'none'}
- Cooking Requests: \${data.cookingRequests || 'none'}
- Store: \${data.store || 'any'}
- Calendar Insights: \${data.calendarInsights || 'none'}
- Feedback: \${data.feedback || 'none'}

Please create a customized \${data.duration}-day meal plan using weekday names. Use easier meals on busy days based on calendar inputs. Include only \${data.meals?.join(', ') || 'all meals'} per day.
\`;
};

app.post('/api/mealplan', async (req, res) => {
  try {
    const prompt = formatPrompt(req.body);
    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful meal planning assistant.' },
        { role: 'user', content: prompt }
      ]
    });
    const mealPlan = chat.choices[0]?.message?.content;
    res.json({ mealPlan });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Meal plan generation failed' });
  }
});

const generatePdf = async (title, content) => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(content.slice(0, 1000), {
    x: 50,
    y: page.getHeight() - 100,
    size: 12,
    font,
    color: rgb(0, 0, 0)
  });
  const pdfBytes = await pdfDoc.save();
  const filename = \`/tmp/\${title.replace(/\s+/g, '_')}.pdf\`;
  await fs.writeFile(filename, pdfBytes);
  return \`https://mealplan-final.onrender.com/static/\${title.replace(/\s+/g, '_')}.pdf\`;
};

app.use('/static', express.static('/tmp'));

app.post('/api/finalize', async (req, res) => {
  try {
    const { mealPlan } = req.body;
    const planPdf = await generatePdf('Meal Plan', mealPlan || 'No content');
    const recipesPdf = await generatePdf('Recipes', 'Recipes based on the plan');
    const shoppingPdf = await generatePdf('Shopping List', 'Shopping list based on the plan');
    res.json({ planPdf, recipesPdf, shoppingPdf });
  } catch (err) {
    res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
