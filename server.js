// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/mealplan', async (req, res) => {
  try {
    const { feedback, ...userData } = req.body;
    const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const meals = userData.meals || [];
    const days = parseInt(userData.duration || '7');
    const calendarNotes = userData.calendarInsights || '';

    const prompt = feedback ? 
      `Please revise this meal plan based on the following feedback: ${feedback}\n\nOriginal Data: ${JSON.stringify(userData)}` :
      `Create a ${days}-day custom meal plan for ${userData.people || 1} people, focusing on ${meals.join(', ')}. 
       Use these calendar notes for easier meals on busy days: ${calendarNotes}. 
       Format each day using weekday names starting from today.
       Details: ${JSON.stringify(userData)}.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
    });

    const mealPlan = completion.choices[0].message.content;
    res.json({ mealPlan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Meal plan generation failed' });
  }
});

app.post('/api/finalize', async (req, res) => {
  try {
    const { name, mealPlan } = req.body;

    // Simple PDF generator
    const createPdf = async (title, content) => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const { width, height } = page.getSize();
      const lines = content.match(/.{1,90}/g) || [];

      page.drawText(`${title} for ${name}`, { x: 50, y: height - 50, size: 14, font });
      lines.forEach((line, i) => {
        page.drawText(line, {
          x: 50,
          y: height - 70 - i * 16,
          size: 11,
          font,
        });
      });

      const pdfBytes = await pdfDoc.save();
      return Buffer.from(pdfBytes);
    };

    const planPdf = await createPdf('Meal Plan', mealPlan);
    const recipesPdf = await createPdf('Recipes', 'Recipes coming soon...');
    const shoppingPdf = await createPdf('Shopping List', 'Shopping list coming soon...');

    // Save or upload PDF logic here
    // For now, just mock URLs
    res.json({
      planPdf: 'https://example.com/plan.pdf',
      recipesPdf: 'https://example.com/recipes.pdf',
      shoppingPdf: 'https://example.com/shopping.pdf'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

app.listen(port, () => {
  console.log(`Meal plan server running on port ${port}`);
});
