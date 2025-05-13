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
  formData.shoppingList
