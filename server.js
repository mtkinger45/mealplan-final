// server.js with caching
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cacheDir = './cache';

await fs.mkdir(cacheDir, { recursive: true });

const allowedOrigins = ['https://thechaostoconfidencecollective.com'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('CORS not allowed from this origin'));
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '5mb' }));

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\*\*/g, '').trim();
}

function getSessionPath(sessionId) {
  return path.join(cacheDir, `${sessionId}.json`);
}

async function saveToCache(sessionId, data) {
  const filePath = getSessionPath(sessionId);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function loadFromCache(sessionId) {
  const filePath = getSessionPath(sessionId);
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = uuidv4();
    const feedbackNote = data.feedback ? `User feedback: "${data.feedback}"` : '';

    const prompt = `You are a professional meal planner. Create a ${data.duration || 7}-day meal plan with ${data.meals?.join(', ') || 'Supper'}.

Diet: ${data.dietType}
Preferences: ${data.dietaryPreferences}
Style: ${data.mealStyle}
Requests: ${data.cookingRequests}
Appliances: ${data.appliances?.join(', ')}
On Hand: ${data.onHandIngredients}
Schedule: ${data.calendarInsights}
People: ${data.people || 4}
${feedbackNote}

Use US measurements. Bold each day. Avoid placeholder text. End with "Shopping List:" grouped by category and excluding on-hand items.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional meal planner.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    const output = completion.choices[0].message.content;
    const [mealPlan, shoppingList] = output.split(/(?=Shopping List:)/i);

    const recipePrompt = `Write complete recipes based on the meal plan:
${stripHtml(mealPlan)}

Each recipe should include:
- Title
- Ingredients in US units
- Instructions
- Prep and Cook Time
- Macros per serving
Avoid placeholder text.`;

    const recipeCompletion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a recipe writer.' },
        { role: 'user', content: recipePrompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    const recipes = recipeCompletion.choices[0].message.content;
    const result = {
      sessionId,
      mealPlan: stripHtml(mealPlan),
      shoppingList: stripHtml(shoppingList),
      recipes: stripHtml(recipes)
    };

    await saveToCache(sessionId, result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating meal plan.' });
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;
  const filename = `${sessionId}-${type}.pdf`;

  const bucketName = process.env.AWS_BUCKET_NAME;

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: filename,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ url: signedUrl });
  } catch (error) {
    console.error('Error generating signed URL:', error.message);
    res.status(404).json({ error: 'PDF not found' });
  }
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
