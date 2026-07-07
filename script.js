// script.js - Meal Planner V3 frontend
let formData = {};
let latestResult = null;

const API_BASE = window.MEALPLANNER_API_BASE || 'https://mealplan-final.onrender.com';

function $(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const box = $('results');
  box.style.display = 'block';
  box.textContent = message;
}

function showError(message, requestId) {
  const box = $('results');
  box.style.display = 'block';
  box.innerHTML = `<div class="error"><strong>We couldn’t generate your plan.</strong><br>${message}${requestId ? `<br><small>Request ID: ${requestId}</small>` : ''}</div>`;
}

function renderPlan(result) {
  const plan = result.plan;
  let html = '';

  if (result.summary) html += `<p><strong>${escapeHtml(result.summary)}</strong></p>`;

  for (const day of plan.mealPlan || []) {
    html += `<h3>${escapeHtml(day.day)}</h3>`;
    for (const meal of day.meals || []) {
      html += `<p><strong>${escapeHtml(meal.type)}:</strong> ${escapeHtml(meal.title)}${meal.notes ? `<br><small>${escapeHtml(meal.notes)}</small>` : ''}</p>`;
    }
  }

  $('results').innerHTML = html;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function gatherFormData(form) {
  const formDataRaw = new FormData(form);
  const data = Object.fromEntries(formDataRaw.entries());
  data.meals = formDataRaw.getAll('meals');
  data.appliances = formDataRaw.getAll('appliances');
  return data;
}

async function generatePlan(data, loadingText) {
  setStatus(loadingText);

  const response = await fetch(`${API_BASE}/api/mealplan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  let result;
  try {
    result = await response.json();
  } catch (err) {
    throw new Error('The server returned a response we could not read.');
  }

  if (!response.ok || !result.ok) {
    const err = new Error(result.error || 'Meal plan generation failed.');
    err.requestId = result.requestId;
    throw err;
  }

  if (!result.plan || !result.sessionId) {
    const err = new Error('The server returned an incomplete meal plan.');
    err.requestId = result.requestId;
    throw err;
  }

  return result;
}

window.addEventListener('DOMContentLoaded', () => {
  const saved = JSON.parse(localStorage.getItem('mealPlanForm') || '{}');
  if (saved && Object.keys(saved).length) {
    formData = saved;
    Object.entries(saved).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((val) => {
          const box = document.querySelector(`input[name="${key}"][value="${CSS.escape(val)}"]`);
          if (box) box.checked = true;
        });
      } else {
        const field = document.querySelector(`[name="${key}"]`);
        if (field && value !== '') field.value = value;
      }
    });
  }
});

$('combinedForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const form = e.target;
  const submitButton = form.querySelector('button[type="submit"]');

  try {
    submitButton.disabled = true;
    formData = gatherFormData(form);
    localStorage.setItem('mealPlanForm', JSON.stringify(formData));
    form.style.display = 'none';

    latestResult = await generatePlan(formData, 'Building your custom meal plan...');
    Object.assign(formData, {
      sessionId: latestResult.sessionId,
      recipes: latestResult.recipes,
      shoppingList: latestResult.shoppingList
    });

    renderPlan(latestResult);
    $('feedbackForm').style.display = 'block';
    $('reviseButton').style.display = 'inline-block';
    $('approveButton').style.display = 'inline-block';
  } catch (err) {
    form.style.display = 'block';
    showError(err.message, err.requestId);
  } finally {
    submitButton.disabled = false;
  }
});

$('feedbackForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const feedbackTextarea = e.target.feedback;
  const feedback = feedbackTextarea.value;
  const updatedData = { ...formData, feedback };

  try {
    latestResult = await generatePlan(updatedData, 'Updating your plan with feedback...');
    feedbackTextarea.value = '';
    Object.assign(formData, {
      ...updatedData,
      sessionId: latestResult.sessionId,
      recipes: latestResult.recipes,
      shoppingList: latestResult.shoppingList
    });
    renderPlan(latestResult);
  } catch (err) {
    showError(err.message, err.requestId);
  }
});

$('reviseButton').addEventListener('click', () => {
  $('combinedForm').style.display = 'block';
  $('feedbackForm').style.display = 'none';
  $('results').style.display = 'none';
  $('reviseButton').style.display = 'none';
  $('approveButton').style.display = 'none';
  $('downloadLinks').style.display = 'none';
});

$('approveButton').addEventListener('click', async () => {
  const button = $('approveButton');
  button.disabled = true;
  button.innerText = 'Generating downloads...';

  const sessionId = formData.sessionId;
  const types = ['mealplan', 'recipes', 'shopping-list'];
  const labels = ['Meal Plan', 'Recipes', 'Shopping List'];
  let links = '';

  for (let i = 0; i < types.length; i++) {
    try {
      const response = await fetch(`${API_BASE}/api/pdf/${sessionId}?type=${types[i]}`);
      const result = await response.json();
      if (!response.ok || !result.ok || !result.url) throw new Error(result.error || 'PDF failed');
      links += `<a href="${result.url}" target="_blank" rel="noopener">${labels[i]} PDF</a>`;
    } catch (err) {
      links += `<span class="error">Failed to load ${labels[i]} PDF</span>`;
    }
  }

  $('downloadLinks').innerHTML = `<p><strong>Downloads Ready:</strong></p>${links}`;
  $('downloadLinks').style.display = 'block';
  button.innerText = 'Download Links Ready';
  button.disabled = false;
});
