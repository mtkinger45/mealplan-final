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
// Shopping list: retain practical units and aggregate equivalent ingredients.
const unitConversion = {
  tsp: { to: 'tsp', factor: 1 }, teaspoon: { to: 'tsp', factor: 1 }, teaspoons: { to: 'tsp', factor: 1 },
  tbsp: { to: 'tsp', factor: 3 }, tablespoon: { to: 'tsp', factor: 3 }, tablespoons: { to: 'tsp', factor: 3 },
  cup: { to: 'tsp', factor: 48 }, cups: { to: 'tsp', factor: 48 },
  lb: { to: 'lb', factor: 1 }, lbs: { to: 'lb', factor: 1 }, pound: { to: 'lb', factor: 1 }, pounds: { to: 'lb', factor: 1 },
  oz: { to: 'lb', factor: 1/16 }, ounce: { to: 'lb', factor: 1/16 }, ounces: { to: 'lb', factor: 1/16 },
  g: { to: 'g', factor: 1 }, grams: { to: 'g', factor: 1 },
  clove: { to: 'clove', factor: 1 }, cloves: { to: 'clove', factor: 1 },
  slice: { to: 'slice', factor: 1 }, slices: { to: 'slice', factor: 1 },
  can: { to: 'can', factor: 1 }, cans: { to: 'can', factor: 1 },
  package: { to: 'package', factor: 1 }, packages: { to: 'package', factor: 1 },
  scoop: { to: 'scoop', factor: 1 }, scoops: { to: 'scoop', factor: 1 },
  head: { to: 'count', factor: 1 }, heads: { to: 'count', factor: 1 }, bunch: { to: 'count', factor: 1 }, bunches: { to: 'count', factor: 1 }, piece: { to: 'count', factor: 1 }, pieces: { to: 'count', factor: 1 }, whole: { to: 'count', factor: 1 }, large: { to: 'count', factor: 1 }, medium: { to: 'count', factor: 1 }, small: { to: 'count', factor: 1 },
};
function normalizeUnit(unit = '') {
  const u = String(unit).toLowerCase().replace(/\.$/, '');
  return unitConversion[u]?.to || (u || 'count');
}
function normalizeIngredient(name) {
  let n = String(name).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bcut\s+into\b.*$/i, ' ')
    .replace(/\b(?:into|cut|sliced|chopped|diced)\s+[-\w\s]*?(?:pieces|wedges|chunks|rounds)\b.*$/i, ' ')
    .replace(/\b(?:for|to)\s+serv(?:e|ing)\b.*$/i, ' ')
    .replace(/\b(?:into|in)\s+(?:\d+|one|half)[-\s]*inch\b.*$/i, ' ')
    .replace(/\b(?:for serving|for garnish|for topping|for cooking|to taste|as needed)\b.*$/i, ' ')
    .replace(/\b(?:fresh|large|medium|small|chopped|diced|minced|sliced|thinly|thickly|trimmed|optional|coarsely|finely|halved|juiced|zested|drained|shredded|grated|boneless|bone-in|skinless|low-sodium|lowfat|cubed|peeled|raw|unsalted|pure|dried|ground|wedges|chunks|pieces|rounds|divided)\b/g, ' ')
    .replace(/[^a-z\s-]/g, ' ').replace(/\bof\b/g,' ').replace(/\s+/g,' ').trim();
  // Some recipe responses put a unit into the ingredient name instead of
  // separating it into the quantity field. Remove the unit from the name,
  // but never invent an amount for it.
  n = n.replace(/^(?:cups?|tablespoons?|teaspoons?|tbsps?|tsps?)\s+/, '');
  if (/^(?:black|white)\s+pepper$/.test(n)) return n;
  if (/^chicken\s+(?:stock|broth)$/.test(n)) return 'chicken broth';
  if (/^(?:low sodium\s+)?beef\s+(?:stock|broth)$/.test(n)) return 'beef broth';
  // Preserve meaningful varieties, while merging prep descriptions and plurals.
  if (/\b(?:red|yellow|green|orange)\s+bell\s+peppers?\b/.test(n))
    return n.match(/\b(red|yellow|green|orange)\s+bell\s+peppers?\b/)[1] + ' bell pepper';
  if (/\bbell\s+peppers?\b/.test(n)) return 'bell pepper';
  if (/\bred\s+onions?\b/.test(n)) return 'red onion';
  if (/\b(?:yellow|white|sweet)\s+onions?\b/.test(n)) return n.match(/\b(yellow|white|sweet)\s+onions?\b/)[1] + ' onion';
  if (/\b(?:garlic\s+cloves?|cloves?\s+garlic|garlic)\b/.test(n) && !/powder|salt/.test(n)) return 'garlic';
  if (/\bvanilla\s+extract\b/.test(n)) return 'vanilla extract';
  if (/^(?:(?:kosher|sea|table|fine|coarse|iodized)\s+)?salt$/.test(n) || /^(?:teaspoons?|tablespoons?|tsp|tbsp)\s+(?:(?:kosher|sea|table)\s+)?salt$/.test(n)) return 'salt';
  if (/\bgreek\s+yogurt\b/.test(n)) return 'greek yogurt';
  if (/\bgluten[- ]free\s+granola\b/.test(n)) return 'gluten-free granola';
  if (/\b(?:smoked\s+)?paprika\b/.test(n)) return 'paprika';
  if (/\bthyme\b/.test(n)) return 'thyme';
  if (/\bolive\s+oil\b/.test(n)) return 'olive oil';
  if (/\b(?:lemons?|limes?|zucchinis?|avocados?)\b/.test(n) && !/juice|zest/.test(n)) {
    const m=n.match(/\b(lemons?|limes?|zucchinis?|avocados?)\b/)[1];
    return ({lemons:'lemon',limes:'lime',zucchinis:'zucchini',avocados:'avocado'})[m] || m;
  }
  if (/\b(?:butter\s+lettuce|lettuce\s+butter)\b/.test(n)) return 'butter lettuce';
  if (/\bcauliflower\b/.test(n)) return 'cauliflower';
  if (/\bred\s+onion\b/.test(n)) return 'red onion';
  if (/\b(?:red|yellow|green|orange)\s+bell\s+pepper\b/.test(n)) return n.match(/\b(red|yellow|green|orange)\s+bell\s+pepper\b/)[1] + ' bell pepper';
  if (/\bzucchini\b/.test(n)) return 'zucchini';
  const aliases = [
    [/^butter.*$/, 'butter'], [/^onions?$/, 'onion'],
    [/^tomatoes$/, 'tomato'], [/^carrots$/, 'carrot'],
    [/^eggs?$/, 'eggs'], [/^chicken breasts?$/, 'chicken breast'],
    [/^salmon fillets?$/, 'salmon'],
  ];
  for (const [pattern, replacement] of aliases) if (pattern.test(n)) return replacement;
  return n;
}
function parseQuantity(value) {
  const v = value.trim();
  if (/^\d+\s+\d+\/\d+$/.test(v)) {
    const [whole, fraction] = v.split(/\s+/);
    const [num, den] = fraction.split('/').map(Number);
    return Number(whole) + num / den;
  }
  if (/^\d+\/\d+$/.test(v)) {
    const [num, den] = v.split('/').map(Number);
    return num / den;
  }
  return Number(v);
}
function parseStructuredIngredients(text) {
  const matches = text.match(/\*\*Ingredients:\*\*[\s\S]*?(?=\*\*Instructions:|\*\*Prep Time|---|$)/g) || [];
  const items = [];
  for (const block of matches) {
    for (const line of block.split('\n').slice(1)) {
      const clean = line.replace(/^\s*[-•]\s*/, '').trim();
      if (!clean || /^(?:salt|pepper)\s+(?:and\s+pepper\s+)?to taste/i.test(clean)) continue;
      const m = clean.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(?:-\s*)?([a-zA-Z-]+)?\s*(.*)$/);
      if (!m) {
        // Some AI responses omit the number but leave a measurement word,
        // e.g. 'teaspoon salt' or 'teaspoons salt'. Never treat these as
        // separate ingredients or invent a numeric amount.
        const bareSalt = clean.match(/^(?:(teaspoons?|tablespoons?|tsp|tbsp)\s+)?(?:(?:kosher|sea|table|fine|coarse|iodized)\s+)?salt$/i);
        if (bareSalt) {
          const unitWord = (bareSalt[1] || '').toLowerCase();
          if (/^(teaspoon|tablespoon|tsp|tbsp)$/.test(unitWord)) {
            const unit = normalizeUnit(unitWord);
            items.push({name:'salt',unit:'unspecified',qty:1});
          } else {
            items.push({name:'salt',unit:'unspecified',qty:1});
          }
          continue;
        }
        // No numeric amount: do not silently turn 'cup chicken broth' or
        // 'teaspoon black pepper' into one whole item.
        const missingQtyName = clean.replace(/^(?:cups?|tablespoons?|teaspoons?|tbsps?|tsps?)\s+/i, '');
        items.push({name:normalizeIngredient(missingQtyName),unit:'unspecified',qty:1});
        continue;
      }
      const qty = parseQuantity(m[1]);
      let unit = (m[2] || '').toLowerCase();
      let name = m[3] || '';
      if (unit && !unitConversion[unit]) { name = unit + ' ' + name; unit = 'count'; }
      name = name.replace(/\b(?:cut into|sliced into|chopped into)\b.*$/i, '').trim();
      if (!name.trim()) continue;
      // Ingredient names such as 'cloves garlic' are correctly parsed as a unit.
      items.push({name:normalizeIngredient(name),unit:normalizeUnit(unit),qty:qty * (unitConversion[unit]?.factor || 1)});
    }
  }
  return items;
}
function shoppingAmount(qty, unit) {
  const fractions = [[0.125,'1/8'],[0.25,'1/4'],[0.333333,'1/3'],[0.5,'1/2'],[0.666667,'2/3'],[0.75,'3/4'],[0.875,'7/8']];
  function pretty(n) {
    const whole = Math.floor(n + 1e-7);
    const frac = n - whole;
    if (frac < 0.04) return String(whole);
    const best = fractions.reduce((a,b)=>Math.abs(b[0]-frac)<Math.abs(a[0]-frac)?b:a);
    if (Math.abs(best[0]-frac)<0.045) return (whole ? whole+' ' : '')+best[1];
    return String(Math.round(n*10)/10);
  }
  if (unit === 'tsp') {
    if (qty >= 48) { const cups=qty/48; return pretty(cups) + (Math.abs(cups-1)<0.001 ? ' cup' : ' cups'); }
    if (qty >= 3) return pretty(qty/3) + ' tbsp';
    return pretty(qty) + ' tsp';
  }
  if (unit === 'lb') return qty < 1 ? pretty(qty*16) + ' oz' : pretty(qty) + ' lb';
  if (unit === 'count') return pretty(qty);
  if (unit === 'clove') return pretty(qty) + (Math.abs(qty-1)<0.001 ? ' clove' : ' cloves');
  return pretty(qty) + ' ' + (unit === 'clove' && qty !== 1 ? 'cloves' : unit === 'slice' && qty !== 1 ? 'slices' : unit);
}
function categorizeIngredient(name) {
  const i = name.toLowerCase();
  if (/lemon|lime|avocado/.test(i)) return 'Produce';
  if (/^(?:black|white) pepper$/.test(i)) return 'Pantry';
  if (/^(?:chicken|beef) broth$/.test(i)) return 'Pantry';
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
  if (/butter|ghee|oil|vinegar|sugar|vanilla|salt|thyme|paprika|oregano|black pepper|white pepper|chicken broth|beef broth/.test(i)) return 'Pantry';
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
- Include exact quantities for every ingredient.
- Include estimated macros PER SERVING, with numeric grams for all three: Protein, Fat, Carbs. Never leave the macros heading blank.
- Output MUST follow this format exactly:

${header}
**Ingredients:**
- item with quantity and unit
**Instructions:**
1. step-by-step instructions
**Prep Time:** X minutes
**Macros:** Protein: 35g, Fat: 20g, Carbs: 15g

The macro numbers above are examples only. Estimate values for the actual recipe.`;

  // First pass (more creative)
  const first = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'You are a professional recipe writer.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    max_tokens: 1800,
  });

  let text = first.choices?.[0]?.message?.content?.trim() || '';

  // Drift check: must begin with exact header
  if (!text.startsWith(header)) {
    console.warn('[RECIPE HEADER MISMATCH] Retrying with stricter settings for:', header);

    const retry = await openai.chat.completions.create({
      model: 'gpt-4.1',
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
      max_tokens: 1800,
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
      model: 'gpt-4.1',
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
      if (!name || !Number.isFinite(qty) || qty <= 0) continue;
      const key = `${name}|${unit}`;
      if (!aggregated[key]) aggregated[key] = { name, qty: 0, unit };
      aggregated[key].qty += qty;
    }

    // Only subtract on-hand amounts when a matching measurement is unambiguous.
    // Retain the original behavior for count-based entries.
    const onHandLines = onHandIngredients?.toLowerCase().split(/\n|,/) || [];
    const onHandMap = buildOnHandMap(onHandLines);
    for (const item of Object.values(aggregated)) {
      if (item.unit === 'count' && onHandMap[item.name]) {
        item.qty = Math.max(0, item.qty - onHandMap[item.name]);
      }
    }

    // One shopping-list row per normalized ingredient. Never add unlike units
    // (for example, 2 garlic cloves and 1 tbsp minced garlic).
    const byName = {};
    Object.values(aggregated).forEach(({ name, qty, unit }) => {
      if (qty <= 0) return;
      if (!byName[name]) byName[name] = [];
      byName[name].push({ qty, unit });
    });
    // Consolidate aliases to one shopping row. Different units remain separate
    // rather than making unsafe volume-to-whole-vegetable conversions.
    const categorized = {};
    Object.entries(byName).forEach(([name, amounts]) => {
      const cat = categorizeIngredient(name);
      if (!categorized[cat]) categorized[cat] = [];
      const known = amounts.filter(a=>a.unit !== 'unspecified');
      const unknown = amounts.some(a=>a.unit === 'unspecified');
      const formatted = known.sort((a,b)=>a.unit.localeCompare(b.unit))
        .map(({qty,unit}) => shoppingAmount(qty,unit)).join(' + ');
      const note = unknown ? (formatted ? ' (plus amount unspecified in recipe)' : 'amount unspecified in recipe') : '';
      categorized[cat].push(`${capitalize(name)}: ${formatted}${note}`);
    });

    let rebuiltShoppingList = '';
    for (const category of Object.keys(categorized).sort()) {
      rebuiltShoppingList += `\n${category}:\n`;
      for (const item of categorized[category].sort((a,b)=>a.localeCompare(b))) {
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
