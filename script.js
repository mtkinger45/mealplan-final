let formData = {};
let mealPlanText = '';

window.addEventListener('DOMContentLoaded', () => {
  const saved = JSON.parse(localStorage.getItem('mealPlanForm'));
  if (saved) {
    formData = saved;
    Object.entries(saved).forEach(([key, value]) => {
      const field = document.querySelector(`[name="${key}"]`);
      if (field) {
        if (field.type === 'checkbox' && Array.isArray(value)) {
          value.forEach(val => {
            const box = document.querySelector(`input[name="${key}"][value="${val}"]`);
            if (box) box.checked = true;
          });
        } else if (field.type === 'checkbox') {
          const box = document.querySelector(`input[name="${key}"][value="${value}"]`);
          if (box) box.checked = true;
        } else if (value !== '') {
          field.value = value;
        }
      }
    });
  }
});

document.getElementById('combinedForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const form = e.target;
  const formDataRaw = new FormData(form);
  const data = Object.fromEntries(formDataRaw.entries());

  data.meals = formDataRaw.getAll('meals');
  data.appliances = formDataRaw.getAll('appliances');

  formData = data;
  localStorage.setItem('mealPlanForm', JSON.stringify(formData));

  const resultsBox = document.getElementById('results');
  resultsBox.textContent = 'Loading your plan...';
  resultsBox.style.display = 'block';
  form.style.display = 'none';

  const response = await fetch('https://mealplan-final.onrender.com/api/mealplan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  const result = await response.json();
  mealPlanText = result.mealPlan;
  formData.recipes = result.recipes;
  formData.shoppingList = result.shoppingList;
  formData.sessionId = result.sessionId;

  resultsBox.textContent = mealPlanText;
  document.getElementById('feedbackForm').style.display = 'block';
  document.getElementById('reviseButton').style.display = 'inline-block';
  document.getElementById('approveButton').style.display = 'inline-block';
});

document.getElementById('feedbackForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const feedbackTextarea = e.target.feedback;
  const feedback = feedbackTextarea.value;
  const updatedData = { ...formData, feedback };

  document.getElementById('results').textContent = 'Updating your plan with feedback...';

  const response = await fetch('https://mealplan-final.onrender.com/api/mealplan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedData)
  });

  const result = await response.json();
  feedbackTextarea.value = '';
  mealPlanText = result.mealPlan;
  formData.recipes = result.recipes;
  formData.shoppingList = result.shoppingList;
  formData.sessionId = result.sessionId;

  document.getElementById('results').textContent = mealPlanText;
});

document.getElementById('reviseButton').addEventListener('click', () => {
  document.getElementById('combinedForm').style.display = 'block';
  document.getElementById('feedbackForm').style.display = 'none';
  document.getElementById('results').style.display = 'none';
  document.getElementById('reviseButton').style.display = 'none';
  document.getElementById('approveButton').style.display = 'none';
  document.getElementById('downloadLinks').style.display = 'none';
});

document.getElementById('approveButton').addEventListener('click', async () => {
  document.getElementById('approveButton').innerText = 'Generating downloads...';

  const sessionId = formData.sessionId;
  const urls = ['mealplan', 'recipes', 'shopping-list'];
  const labels = ['Meal Plan', 'Recipes', 'Shopping List'];

  let links = '';
  for (let i = 0; i < urls.length; i++) {
    try {
      const response = await fetch(`https://mealplan-final.onrender.com/api/pdf/${sessionId}?type=${urls[i]}`);
      const result = await response.json();
      if (result.url) {
        links += `<a href="${result.url}" target="_blank">${labels[i]} PDF</a>`;
      }
    } catch (err) {
      links += `<span style="color: red;">⚠️ Failed to load ${labels[i]} PDF</span>`;
    }
  }

  const downloadsDiv = document.getElementById('downloadLinks');
  downloadsDiv.innerHTML = `<p><strong>✅ Downloads Ready:</strong></p>${links}`;
  downloadsDiv.style.display = 'block';
  document.getElementById('approveButton').innerText = 'Download Links Ready';
});
