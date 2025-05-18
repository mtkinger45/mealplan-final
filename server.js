// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createPdfFromText, uploadPdfToS3 } from './pdf.js';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_DIR = './cache';

app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = ['https://thechaostoconfidencecollective.com'];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('[CORS BLOCKED ORIGIN]', origin);
      callback(new Error('CORS not allowed from this origin'));
    }
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '5mb' }));

function stripFormatting(text) {
  return text.replace(/<b>(.*?)<\/b>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*/g, '');
}

function parseStructuredIngredients(text) {
  const matches = text.match(/\*\*Ingredients:\*\*[\s\S]*?(?=\*\*Instructions:|\*\*Prep Time|\*\*Macros|---|$)/g) || [];
  const items = [];
  for (const block of matches) {
    const lines = block.split('\n').slice(1);
    for (const line of lines) {
      const clean = line.replace(/^[-•]\s*/, '').trim();
      if (!clean || /to taste|optional/i.test(clean)) continue;
      const match = clean.match(/(\d+(?:\.\d+)?)(?:\s+)?([a-zA-Z]+)?\s+(.+)/);
      if (match) {
        const [, qty, unit, name] = match;
        items.push({ name: normalizeIngredient(name), unit: normalizeUnit(unit), qty: parseFloat(qty) });
      } else {
        items.push({ name: normalizeIngredient(clean), unit: '', qty: 1 });
      }
    }
  }
  return items;
}

function normalizeIngredient(name) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(fresh|large|medium|small|chopped|diced|minced|sliced|thinly|thickly|trimmed|optional|to taste|as needed|coarsely|finely|halved|juiced|zest|drained|shredded|grated|boneless|skinless|low-sodium|lowfat|for garnish)\b/gi, '')
    .replace(/[^a-zA-Z\s]/g, '')
    .replace(/\bof\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\blemon juice\b.*$/, 'lemon juice')
    .replace(/\bcheddar cheese\b.*$/, 'cheddar cheese')
    .replace(/\bwhole milk\b.*$/, 'milk')
    .replace(/\begg[s]?\b.*$/, 'eggs')
    .replace(/\bonion[s]?\b.*$/, 'onions')
    .replace(/\bpepper[s]?\b.*$/, 'peppers');
}

function normalizeUnit(unit = '') {
  const u = unit.toLowerCase();
  if (["cup", "cups"].includes(u)) return "cups";
  if (["tbsp", "tablespoon", "tablespoons"].includes(u)) return "tbsp";
  if (["tsp", "teaspoon", "teaspoons"].includes(u)) return "tsp";
  if (["oz", "ounce", "ounces"].includes(u)) return "oz";
  if (["lb", "lbs", "pound", "pounds"].includes(u)) return "lbs";
  if (["clove", "cloves"].includes(u)) return "cloves";
  if (["slice", "slices"].includes(u)) return "slices";
  if (["egg", "eggs"].includes(u)) return "eggs";
  return u;
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
  if (/lettuce|spinach|zucchini|broccoli|onion|pepper|cucumber|radish|mushroom|cauliflower|tomato|peas|green beans|asparagus|cabbage/.test(i)) return 'Produce';
  if (/butter|ghee|oil|olive|vinegar|sugar/.test(i)) return 'Pantry';
  return 'Other';
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function adjustQuantitiesWithOnHand(aggregated, onHandList) {
  const onHandMap = {};
  for (const entry of onHandList) {
    const normalized = normalizeIngredient(entry);
    const match = normalized.match(/(\d+)\s+([a-zA-Z]+)?\s*(.*)/);
    if (match) {
      const [, qty, unitRaw, name] = match;
      const unit = normalizeUnit(unitRaw);
      const key = `${normalizeIngredient(name)}|${unit}`;
      onHandMap[key] = parseFloat(qty);
    }
  }
  const used = [];
  const adjusted = {};
  for (const key in aggregated) {
    const { name, qty, unit } = aggregated[key];
    const mapKey = `${name}|${unit}`;
    const onHandQty = onHandMap[mapKey] || 0;
    const newQty = Math.max(0, qty - onHandQty);
    adjusted[key] = { name, unit, qty: newQty };
    if (onHandQty > 0) used.push(`${capitalize(name)}: ${Math.min(qty, onHandQty)} ${unit}`);
  }
  return { adjusted, used };
}
