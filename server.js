{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 import express from 'express';\
import cors from 'cors';\
import \{ OpenAI \} from 'openai';\
import dotenv from 'dotenv';\
\
dotenv.config();\
const app = express();\
const port = process.env.PORT || 3000;\
\
app.use(cors());\
app.use(express.json());\
\
const openai = new OpenAI(\{\
  apiKey: process.env.OPENAI_API_KEY,\
\});\
\
app.post('/api/mealplan', async (req, res) => \{\
  const data = req.body;\
\
  const mealTypes = Array.isArray(data.meals)\
    ? data.meals.join(', ')\
    : data.meals || 'Breakfast, Lunch, and Supper';\
\
  const appliances = Array.isArray(data.appliances)\
    ? data.appliances.join(', ')\
    : data.appliances || 'any';\
\
  const prompt = `\
You are a helpful meal planner AI. Create a $\{data.duration || '7'\}-day meal plan for a household of $\{data.people || '4'\} people following a $\{data.dietType || 'standard'\} diet.\
\
Only include the following meals each day: $\{mealTypes\}.\
\
Daily calorie goal: $\{data.calories || 'flexible'\}.\
Protein goal: $\{data.protein || 'not specified'\} grams.\
\
Avoid these dietary ingredients or allergens: $\{data.dietaryPreferences || 'none'\}.\
Meal style preference: $\{data.mealStyle || 'none'\}.\
Use only these appliances: $\{appliances\}.\
Special requests: $\{data.cookingRequests || 'none'\}.\
\
If helpful, this is their budget: $\{data.budget || 'not specified'\} and preferred store: $\{data.store || 'any'\}.\
\
These ingredients are already in their kitchen: $\{data.onHandIngredients || 'none'\}.\
And their weekly schedule is: $\{data.calendarInsights || 'not specified'\}.\
\
If feedback is provided, take it into account: $\{data.feedback || 'none'\}.\
\
Format the meal plan clearly by day and meal.\
`;\
\
  try \{\
    const completion = await openai.chat.completions.create(\{\
      model: "gpt-3.5-turbo",\
      messages: [\{ role: "user", content: prompt \}],\
      temperature: 0.7,\
      max_tokens: 2000,\
    \});\
\
    const mealPlan = completion.choices[0]?.message?.content;\
    res.json(\{ mealPlan \});\
  \} catch (error) \{\
    console.error(error);\
    res.status(500).json(\{ error: "Meal plan generation failed" \});\
  \}\
\});\
\
app.listen(port, () => \{\
  console.log(`Meal plan AI server running at http://localhost:$\{port\}`);\
\});\
}