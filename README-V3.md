# Meal Planner V3

## What changed

- One OpenAI request now generates the meal plan, recipes, and shopping list.
- Structured JSON response instead of parsing text blocks.
- No more 7-21 parallel recipe API calls.
- Better Render logs with request IDs.
- Frontend now catches API errors and displays a real message instead of a blank screen.
- PDFs are generated from structured data after the user approves the plan.

## Render environment variables

Required:
- OPENAI_API_KEY
- AWS_REGION
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_BUCKET_NAME

Optional:
- OPENAI_MODEL=gpt-4o-mini
- OPENAI_TIMEOUT_MS=90000
- ALLOWED_ORIGIN=https://thechaostoconfidencecollective.com
- NODE_ENV=production

## Render settings

Build Command:
`npm install`

Start Command:
`npm start`

## Test endpoints

Health check:
`https://YOUR-RENDER-SERVICE.onrender.com/health`

Meal generation:
`POST /api/mealplan`

PDF generation:
`GET /api/pdf/:sessionId?type=mealplan`
`GET /api/pdf/:sessionId?type=recipes`
`GET /api/pdf/:sessionId?type=shopping-list`

## Deployment steps

1. Replace server.js, script.js, pdf.js, package.json, and index.html in GitHub.
2. Commit changes to the branch connected to Render.
3. Render should auto-deploy, or click Manual Deploy.
4. Open /health to confirm V3 is live.
5. Run one test plan with Supper only.
6. Run one test plan with Breakfast, Lunch, and Supper.
7. Approve the plan and test all three PDFs.
