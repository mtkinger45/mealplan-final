// server.js
import express from 'express';
import bodyParser from 'body-parser';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_DIR = './cache';

app.use((req, res, next) => {
  const allowedOrigin = 'https://thechaostoconfidencecollective.com';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(bodyParser.json({ limit: '5mb' }));

function stripFormatting(text) {
  return text
    .replace(/<b>(.*?)<\/b>/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*/g, '');
}

// ----------------------------
// Safer JSON extraction helpers
// ----------------------------
const MEAL_JSON_START = '===MEAL_JSON_START===';
const MEAL_JSON_END = '===MEAL_JSON_END===';

function extractMealsJsonBlock(fullText) {
  const match = fullText.match(
    new RegExp(`${MEAL_JSON_START}([\\s\\S]*?)${MEAL_JSON_END}`)
  );
  if (!match) return null;
  return match[1].trim();
}

function safeJsonParseMeals(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return null;

    // normalize expected shape
    const cleaned = parsed
      .map((x) => ({
        day: (x?.day ?? '').toString().trim(),
        meal: (x?.meal ?? '').toString().trim(),
        title: (x?.title ?? '').toString().trim(),
      }))
      .filter((x) => x.day && x.meal && x.title);

    return cleaned.length ? cleaned : null;
  } catch (e) {
    console.error('[MEALS JSON PARSE ERROR]', e);
    return null;
  }
}

// ----------------------------
// Units + ingredient parsing
// ----------------------------
const unitConversion = {
  tbsp: { to: 'cups', factor: 1 / 16 },
  tsp: { to: 'cups', factor: 1 / 48 },
  oz: { to: 'cups', factor: 1 / 8 },
  cups: { to: 'cups', factor: 1 },
  cloves: { to: 'clove', factor: 1 },
  pounds: { to: 'lb', factor: 1 },
  lbs: { to: 'lb', factor: 1 },
  cup: { to: 'cups', factor: 1 },
  tablespoons: { to: 'tbsp', factor: 1 },
  teaspoons: { to: 'tsp', factor: 1 },
};

function normalizeUnit(unit = '') {
  const u = unit.toLowerCase();
  return unitConversion[u]?.to || u;
}

function overrideUnitForIngredient(name, originalUnit) {
  if (name === 'ribeye steak') return 'lb';
  if (name === 'chicken breasts') return 'lb';
  if (name === 'shrimp') return 'lb';
  return normalizeUnit(originalUnit);
}

function normalizeIngredient(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(
      /\b(fresh|large|medium|small|chopped|diced|minced|sliced|thinly|thickly|trimmed|optional|to taste|as needed|coarsely|finely|halved|juiced|zest(ed)?|drained|shredded|grated|boneless|bonein|skinless|low-sodium|lowfat|cubed|peeled|cut into.*|for garnish(?:ing)?|approximately.*|deveined|raw)\b/gi,
      ''
    )
    .replace(/[^a-zA-Z\s]/g, '')
    .replace(/\bof\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned
    .replace(/extra virgin olive oil|olive oil.*/g, 'olive oil')
    .replace(/butter.*/, 'butter')
    .replace(/unsalted butter/, 'butter')
    .replace(/melted butter/, 'butter')
    .replace(/garlic.*/, 'garlic')
    .replace(/parsley.*/, 'parsley')
    .replace(/soy sauce.*/, 'soy sauce')
    .replace(/apple cider vinegar.*/, 'apple cider vinegar')
    .replace(/black pepper.*/, 'black pepper')
    .replace(/bell pepper.*/, 'bell pepper')
    .replace(/green onion.*/, 'green onion')
    .replace(/scallion.*/, 'green onion')
    .replace(/ribeye.*|lean beef.*|steaks.*|steak.*/g, 'ribeye steak')
    .replace(/fish fillet.*/g, 'fish fillets')
    .replace(/salmon.*/, 'fish')
    .replace(/white fish.*/, 'fish')
    .replace(/shrimp.*/, 'shrimp')
    .replace(/carrots.*/, 'carrots')
    .replace(/lemon juice|lemon slices and herbs|lemons? zested and.*|lemons?|lemon.*/g, 'lemon')
    .replace(/limes?|lime juice.*/g, 'lime')
    .replace(/chicken breast.*/g, 'chicken breasts')
    .replace(/chickens?.*/, 'chicken');
}

function parseStructuredIngredients(text) {
  const matches =
    text.match(/\*\*Ingredients:\*\*[\s\S]*?(?=\*\*Instructions:|\*\*Prep Time|---|$)/g) || [];

  const items = [];
  for (const block of matches) {
    const lines = block.split('\n').slice(1);
    for (const line of lines) {
      const clean = line.replace(/^[-•]\s*/, '').trim();
      if (!clean || /to taste|optional/i.test(clean)) continue;

      // qty unit name (simple parse)
      const match = clean.match(/(\d+(?:\.\d+)?)(?:\s+)?([a-zA-Z]+)?\s+(.+)/);
      if (match) {
        const [, qty, unit, name] = match;
        items.push({
          name: normalizeIngredient(name),
          unit: normalizeUnit(unit),
          qty: parseFloat(qty),
        });
      } else {
        items.push({ name: normalizeIngredient(clean), unit: '', qty: 1 });
      }
    }
  }
  return items;
}

function categorizeIngredient(name) {
  const i = name.toLowerCase();
  if (/lemon|lime|avocado|olive/.test(i)) return 'Fruit';
  if (/beef|ribeye|sirloin|steak|chuck|ground/.test(i)) return 'Meat';
  if (/chicken|thigh|breast|drumstick/.test(i)) return 'Meat';
  if (/pork|bacon|ham|sausage/.test(i)) return 'Meat';
  if (/fish|salmon|tilapia|cod|shrimp/.test(i)) return 'Meat';
  if (/egg/.test(i)) return 'Dairy';
  if (/milk|cream|cheese/.test(i)) return 'Dairy';
  if (
    /lettuce|spinach|zucchini|broccoli|onion|pepper|cucumber|radish|mushroom|cauliflower|tomato|peas|green beans|asparagus|cabbage/.test(
      i
    )
  )
    return 'Produce';
  if (/butter|ghee|oil|vinegar|sugar/.test(i)) return 'Pantry';
  return 'Other';
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function adjustForOnHand(aggregated, onHandMap) {
  for (const key in aggregated) {
    const item = aggregated[key];
    const onHandQty = onHandMap[item.name] || 0;
    item.qty = Math.max(item.qty - onHandQty, 0);
  }
}

function buildOnHandMap(rawList) {
  const map = {};
  for (const line of rawList) {
    const match = line.trim().match(/(\d+(?:\.\d+)?)\s+(.+)/);
    if (match) {
      const [, qty, name] = match;
      const cleaned = normalizeIngredient(name);
      map[cleaned] = parseFloat(qty);
    }
  }
  return map;
}

// ----------------------------
// Recipe generation with drift check + retry
// ----------------------------
function expectedMealHeader(day, meal, title) {
  return `**Meal Name:** ${day} ${meal} – ${title}`;
}

async function generateOneRecipe({ day, meal, title, people }) {
  const header = expectedMealHeader(day, meal, title);

  const prompt = `You are a professional recipe writer.

CRITICAL REQUIREMENTS:
- You MUST start the recipe with this exact line (character-for-character):
${header}
- Do NOT change the meal title, day, or meal type.
- Ingredients must be in U.S. measurements for ${people} people.
- Output MUST follow this format exactly:

${header}
**Ingredients:**
- item with quantity and unit
**Instructions:**
1. step-by-step instructions
**Prep Time:** X minutes
**Macros:** Protein, Fat, Carbs`;

  // First pass (more creative)
  const first = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    max_tokens: 1100,
  });

  let text = first.choices?.[0]?.message?.content?.trim() || '';

  // Drift check: must begin with exact header
  if (!text.startsWith(header)) {
    console.warn('[RECIPE HEADER MISMATCH] Retrying with stricter settings for:', header);

    const retry = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional recipe writer.' },
        {
          role: 'user',
          content:
            prompt +
            `

IMPORTANT: Your output did not start with the exact required header previously.
You MUST begin with:
${header}
No extra text before it.`,
        },
      ],
      temperature: 0,
      max_tokens: 1100,
    });

    const retryText = retry.choices?.[0]?.message?.content?.trim() || '';
    if (retryText.startsWith(header)) {
      text = retryText;
    } else {
      // Last resort: force prepend header if model still messes up
      text = `${header}\n${retryText}`;
    }
  }

  return text;
}

app.post('/api/mealplan', async (req, res) => {
  try {
    const data = req.body;
    const sessionId = randomUUID();

    const {
      duration = 7,
      startDay = 'Monday',
      meals = ['Supper'],
      dietType = 'Any',
      avoidIngredients = 'None',
      mealStyle = 'Any',
      cookingRequests = 'None',
      appliances = [],
      onHandIngredients = 'None',
      calendarInsights = 'None',
      people = 4,
      name = 'Guest',
      feedback = '',
    } = data;

    const avoidBlock =
      avoidIngredients && avoidIngredients.trim().toLowerCase() !== 'none'
        ? `ABSOLUTELY DO NOT include any of the following ingredients in any meals or recipes: ${avoidIngredients}. These are allergies or strictly avoided.`
        : '';

    const feedbackBlock =
      feedback && feedback.trim()
        ? `User has provided the following feedback to revise their plan: ${feedback}. Please prioritize this in the revised plan.`
        : '';

    // NOTE: We now REQUIRE the JSON list inside explicit delimiters.
    const prompt = `You are a professional meal planner.

Create a ${duration}-day meal plan that begins on ${startDay}.
Only include the following meals each day: ${meals.join(', ')}.

User Info:
- Diet Type: ${dietType}
- Cooking Style: ${mealStyle}
- Special Requests: ${cookingRequests}
- Appliances: ${appliances.join(', ') || 'None'}
- On-hand Ingredients: ${onHandIngredients}
- Household size: ${people}
- Calendar Insights: ${calendarInsights || 'None'}

${avoidBlock}

${feedbackBlock}

OUTPUT REQUIREMENTS:
1) First, output the meal plan in a clean readable format (day headings + meal titles).
2) Then output a "Shopping List" section grouped by category (you may include on-hand notes, but we will rebuild it server-side).
3) LAST: Output ONLY a JSON array of meals INSIDE the exact delimiters below.
   - The JSON must be valid JSON (double quotes, no trailing commas).
   - Each item must include: day, meal, title
   - Do NOT include any other bracketed arrays outside this block.

${MEAL_JSON_START}
[{"day":"Monday","meal":"Supper","title":"Example Meal"}]
${MEAL_JSON_END}
`;

    const mealPlanRes = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a professional meal planner.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
      max_tokens: 3200,
    });

    const result = mealPlanRes.choices?.[0]?.message?.content || '';
    const [mealPlanPart] = result.split(/(?=Shopping List)/i);

    const jsonBlock = extractMealsJsonBlock(result);
    const recipeInfoList = jsonBlock ? safeJsonParseMeals(jsonBlock) : null;

    if (!recipeInfoList || !recipeInfoList.length) {
      console.error('[MEALPLAN RAW OUTPUT]', result.slice(0, 2000));
      throw new Error('Meal JSON block missing or invalid — unable to generate recipes.');
    }

    // Generate recipes (with drift-check + retry)
    const recipesArr = await Promise.all(
      recipeInfoList.map(({ day, meal, title }) =>
        generateOneRecipe({ day, meal, title, people })
      )
    );

    const recipes = recipesArr.join('\n\n---\n\n');

    // Build shopping list from structured ingredients in recipes
    const structuredIngredients = parseStructuredIngredients(recipes);
    const aggregated = {};

    for (const { name, qty, unit } of structuredIngredients) {
      if (!name || isNaN(qty)) continue;
      const normName = normalizeIngredient(name);
      const baseUnit = overrideUnitForIngredient(normName, unit);
      const key = `${normName}|${baseUnit}`;

      const factor = unitConversion[unit?.toLowerCase()]?.factor || 1;
      const convertedQty = qty * factor;

      if (!aggregated[key]) aggregated[key] = { name: normName, qty: 0, unit: baseUnit };
      aggregated[key].qty += convertedQty;
    }

    const onHandLines = onHandIngredients?.toLowerCase().split(/\n|,/) || [];
    const onHandMap = buildOnHandMap(onHandLines);
    adjustForOnHand(aggregated, onHandMap);

    const categorized = {};
    Object.values(aggregated).forEach(({ name, qty, unit }) => {
      const cat = categorizeIngredient(name);
      if (!categorized[cat]) categorized[cat] = [];
      const label = `${capitalize(name)}: ${qty} ${unit}`;
      categorized[cat].push(label);
    });

    let rebuiltShoppingList = '';
    for (const category of Object.keys(categorized).sort()) {
      rebuiltShoppingList += `\n${category}:\n`;
      const sortedItems = categorized[category]
        .slice()
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      for (const item of sortedItems) {
        rebuiltShoppingList += `• ${item}\n`;
      }
    }

    // Cache
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(CACHE_DIR, `${sessionId}.json`),
      JSON.stringify(
        {
          name: data.name || 'Guest',
          mealPlan: stripFormatting(mealPlanPart.trim()),
          shoppingList: rebuiltShoppingList.trim(),
          recipes,
        },
        null,
        2
      )
    );

    res.json({
      sessionId,
      mealPlan: stripFormatting(mealPlanPart.trim()),
      shoppingList: rebuiltShoppingList.trim(),
      recipes,
    });
  } catch (err) {
    console.error('[API ERROR]', err);
    res.status(500).json({ error: 'Meal plan generation failed.' });
  }
});

app.get('/api/pdf/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { type } = req.query;
  const filePath = path.join('./cache', `${sessionId}.json`);

  try {
    const cache = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    let content = '',
      filename = '';

    if (type === 'mealplan') {
      content = `Meal Plan for ${cache.name}\n\n${cache.mealPlan}`;
      filename = `${sessionId}-mealplan.pdf`;
    } else if (type === 'recipes') {
      content = cache.recipes;
      filename = `${sessionId}-recipes.pdf`;
    } else if (type === 'shopping-list') {
      content = cache.shoppingList;
      filename = `${sessionId}-shopping.pdf`;
    } else {
      return res.status(400).json({ error: 'Invalid type parameter.' });
    }

    const buffer = await createPdfFromText(content, { type });
    const url = await uploadPdfToS3(buffer, filename);
    res.json({ url });
  } catch (err) {
    console.error('[PDF ERROR]', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
