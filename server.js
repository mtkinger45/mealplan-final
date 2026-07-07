// server.js - Meal Planner V3
// Major changes:
// - One structured OpenAI call creates meal plan, recipes, and shopping list.
// - No 7-21 parallel recipe calls.
// - Safer frontend responses: never silently returns empty success.
// - Request IDs, timing logs, health check, validation, retries, and safer cache writes.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createPdfFromMealPlan, uploadPdfToS3 } from './pdf.js';

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = './cache';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://thechaostoconfidencecollective.com';

if (!process.env.OPENAI_API_KEY) {
  console.warn('[BOOT WARNING] OPENAI_API_KEY is not set. Meal generation will fail until it is configured.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: '5mb' }));

function log(requestId, message, meta = {}) {
  console.log(JSON.stringify({ requestId, message, ...meta, ts: new Date().toISOString() }));
}

function cleanString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function cleanArray(value) {
  if (Array.isArray(value)) return value.map((x) => cleanString(x)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function sanitizeInput(raw = {}) {
  const meals = cleanArray(raw.meals);
  return {
    duration: clampNumber(raw.duration, 7, 1, 14),
    startDay: cleanString(raw.startDay, 'Monday'),
    meals: meals.length ? meals : ['Supper'],
    dietType: cleanString(raw.dietType, 'Any'),
    avoidIngredients: cleanString(raw.avoidIngredients, 'None'),
    mealStyle: cleanString(raw.mealStyle, 'Any'),
    cookingRequests: cleanString(raw.cookingRequests, 'None'),
    appliances: cleanArray(raw.appliances),
    onHandIngredients: cleanString(raw.onHandIngredients, 'None'),
    calendarInsights: cleanString(raw.calendarInsights, 'None'),
    people: clampNumber(raw.people, 4, 1, 20),
    name: cleanString(raw.name, 'Guest'),
    feedback: cleanString(raw.feedback, '')
  };
}

function buildPrompt(data) {
  const avoidBlock = data.avoidIngredients.toLowerCase() !== 'none'
    ? `Avoid these ingredients completely in meal titles, recipes, and shopping list: ${data.avoidIngredients}`
    : 'No strict avoided ingredients were provided.';

  const feedbackBlock = data.feedback
    ? `This is a revision. Prioritize this user feedback: ${data.feedback}`
    : 'This is a first draft. No revision feedback was provided.';

  return `Create a practical, family-friendly meal plan for The Chaos to Confidence Collective.

User details:
- Name: ${data.name}
- Duration: ${data.duration} days
- Start day: ${data.startDay}
- Meals requested each day: ${data.meals.join(', ')}
- Household size: ${data.people}
- Diet type: ${data.dietType}
- Preferred cooking style: ${data.mealStyle}
- Special cooking requests: ${data.cookingRequests}
- Appliances available: ${data.appliances.join(', ') || 'None listed'}
- On-hand ingredients: ${data.onHandIngredients}
- Calendar/schedule notes: ${data.calendarInsights}
- ${avoidBlock}
- ${feedbackBlock}

Nutrition/style guardrails:
- Keep meals protein-forward, blood-sugar conscious, simple, and realistic.
- Prefer whole foods, meat/eggs/fish/poultry, vegetables, healthy fats, and fermented foods when appropriate.
- Use U.S. measurements.
- Scale every recipe for exactly ${data.people} people.
- Do not include meals the user did not request.
- Use leftovers strategically when it makes life easier.
- Respect allergies/avoided ingredients strictly.

Return ONLY valid JSON with this exact top-level shape:
{
  "summary": "short friendly summary",
  "mealPlan": [
    { "day": "Monday", "meals": [ { "type": "Supper", "title": "Meal title", "notes": "short note" } ] }
  ],
  "recipes": [
    {
      "day": "Monday",
      "mealType": "Supper",
      "title": "Meal title",
      "servings": ${data.people},
      "ingredients": [
        { "name": "ingredient", "quantity": 1, "unit": "lb", "category": "Meat" }
      ],
      "instructions": ["step one", "step two"],
      "prepTime": "15 minutes",
      "cookTime": "20 minutes",
      "macros": { "protein": "approx grams per serving", "fat": "approx grams per serving", "carbs": "approx grams per serving" }
    }
  ],
  "shoppingList": [
    { "category": "Meat", "items": [ { "name": "ingredient", "quantity": 1, "unit": "lb", "notes": "optional" } ] }
  ]
}

Shopping list requirements:
- Combine duplicate ingredients where reasonable.
- Group by category: Meat, Seafood, Dairy/Eggs, Produce, Ferments, Pantry, Frozen, Other.
- Subtract obvious on-hand ingredients when quantities are clear; otherwise note that the user may already have it.
- Do not include avoided ingredients.`;
}

function validateMealPlanPayload(payload, expectedMeals) {
  if (!payload || typeof payload !== 'object') throw new Error('AI returned empty or invalid JSON object.');
  if (!Array.isArray(payload.mealPlan) || payload.mealPlan.length === 0) throw new Error('AI response missing mealPlan array.');
  if (!Array.isArray(payload.recipes) || payload.recipes.length === 0) throw new Error('AI response missing recipes array.');
  if (!Array.isArray(payload.shoppingList) || payload.shoppingList.length === 0) throw new Error('AI response missing shoppingList array.');

  const allowed = new Set(expectedMeals.map((m) => m.toLowerCase()));
  const unexpected = [];
  for (const day of payload.mealPlan) {
    for (const meal of day.meals || []) {
      if (!allowed.has(String(meal.type || '').toLowerCase())) unexpected.push(meal.type);
    }
  }
  if (unexpected.length) throw new Error(`AI included unrequested meals: ${unexpected.join(', ')}`);

  return payload;
}

async function callOpenAIJson(prompt, requestId, attempt = 1) {
  const started = Date.now();
  log(requestId, 'openai_call_started', { model: MODEL, attempt });

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You create structured JSON meal plans. Return JSON only. No markdown.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: attempt === 1 ? 0.35 : 0.1,
      max_tokens: 12000,
      timeout: OPENAI_TIMEOUT_MS
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned no content.');

    log(requestId, 'openai_call_finished', {
      ms: Date.now() - started,
      finishReason: response.choices?.[0]?.finish_reason,
      chars: content.length
    });

    return JSON.parse(content);
  } catch (err) {
    log(requestId, 'openai_call_failed', { attempt, error: err.message, ms: Date.now() - started });
    if (attempt < 2) return callOpenAIJson(prompt, requestId, attempt + 1);
    throw err;
  }
}

function renderMealPlanText(plan) {
  return (plan.mealPlan || []).map((day) => {
    const meals = (day.meals || [])
      .map((meal) => `${meal.type}: ${meal.title}${meal.notes ? ` — ${meal.notes}` : ''}`)
      .join('\n');
    return `${day.day}\n${meals}`;
  }).join('\n\n');
}

function renderShoppingListText(plan) {
  return (plan.shoppingList || []).map((section) => {
    const items = (section.items || [])
      .map((item) => {
        const qty = item.quantity ? `${item.quantity} ` : '';
        const unit = item.unit ? `${item.unit} ` : '';
        const notes = item.notes ? ` (${item.notes})` : '';
        return `• ${qty}${unit}${item.name}${notes}`;
      })
      .join('\n');
    return `${section.category}:\n${items}`;
  }).join('\n\n');
}

function renderRecipesText(plan) {
  return (plan.recipes || []).map((recipe) => {
    const ingredients = (recipe.ingredients || [])
      .map((item) => `- ${item.quantity || ''} ${item.unit || ''} ${item.name}`.replace(/\s+/g, ' ').trim())
      .join('\n');
    const steps = (recipe.instructions || []).map((step, i) => `${i + 1}. ${step}`).join('\n');
    return `Meal Name: ${recipe.day} ${recipe.mealType} – ${recipe.title}\nServings: ${recipe.servings}\nPrep Time: ${recipe.prepTime || 'N/A'}\nCook Time: ${recipe.cookTime || 'N/A'}\n\nIngredients:\n${ingredients}\n\nInstructions:\n${steps}\n\nMacros: Protein ${recipe.macros?.protein || 'N/A'}, Fat ${recipe.macros?.fat || 'N/A'}, Carbs ${recipe.macros?.carbs || 'N/A'}`;
  }).join('\n\n---\n\n');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mealplanner-v3', model: MODEL, ts: new Date().toISOString() });
});

app.post('/api/mealplan', async (req, res) => {
  const requestId = randomUUID();
  const started = Date.now();

  try {
    const data = sanitizeInput(req.body);
    log(requestId, 'mealplan_request_received', {
      duration: data.duration,
      meals: data.meals,
      people: data.people,
      hasFeedback: Boolean(data.feedback)
    });

    const prompt = buildPrompt(data);
    const aiPayload = await callOpenAIJson(prompt, requestId);
    const plan = validateMealPlanPayload(aiPayload, data.meals);

    const sessionId = randomUUID();
    const cachePayload = {
      requestId,
      sessionId,
      createdAt: new Date().toISOString(),
      input: data,
      plan,
      mealPlan: renderMealPlanText(plan),
      shoppingList: renderShoppingListText(plan),
      recipes: renderRecipesText(plan)
    };

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(cachePayload, null, 2));

    log(requestId, 'mealplan_request_finished', { sessionId, ms: Date.now() - started });

    res.json({
      ok: true,
      requestId,
      sessionId,
      summary: plan.summary || '',
      plan,
      mealPlan: cachePayload.mealPlan,
      shoppingList: cachePayload.shoppingList,
      recipes: cachePayload.recipes
    });
  } catch (err) {
    log(requestId, 'mealplan_request_failed', { error: err.message, stack: err.stack, ms: Date.now() - started });
    res.status(500).json({
      ok: false,
      requestId,
      error: 'Meal plan generation failed. Please try again or shorten special requests/allergy notes.',
      details: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const requestId = randomUUID();
  const { sessionId } = req.params;
  const { type } = req.query;
  const filePath = path.join(CACHE_DIR, `${sessionId}.json`);

  try {
    const cache = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    const buffer = await createPdfFromMealPlan(cache, type);
    const filename = `${sessionId}-${type}.pdf`;
    const url = await uploadPdfToS3(buffer, filename);
    log(requestId, 'pdf_generated', { sessionId, type, filename });
    res.json({ ok: true, url });
  } catch (err) {
    log(requestId, 'pdf_failed', { sessionId, type, error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to generate PDF.' });
  }
});

app.listen(PORT, () => console.log(`Meal Planner V3 running on port ${PORT}`));
