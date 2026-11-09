'use strict';

const form = document.getElementById('loginForm');
const username = document.getElementById('username');
const password = document.getElementById('password');
const errorBox = document.getElementById('loginError');
const submit = document.getElementById('loginSubmit');
const submitLabel = document.getElementById('loginSubmitLabel');
const toggle = document.getElementById('togglePassword');

toggle.addEventListener('click', () => {
  const shown = password.type === 'password';
  password.type = shown ? 'text' : 'password';
  toggle.textContent = shown ? 'إخفاء' : 'إظهار';
  toggle.setAttribute('aria-pressed', String(shown));
  password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled || !form.reportValidity()) return;
  errorBox.hidden = true;
  submit.disabled = true;
  submitLabel.textContent = 'جارٍ التحقق…';
  form.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/auth/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      password.value = '';
      window.location.replace('/');
      return;
    }
    if (response.status === 429) throw new Error('محاولات دخول كثيرة. انتظر قليلًا ثم أعد المحاولة.');
    if (response.status === 401) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
    if (response.status === 403 || response.status === 421) throw new Error('تعذر التحقق من عنوان البوابة. تواصل مع مسؤول النظام.');
    throw new Error('تعذر تسجيل الدخول الآن. أعد المحاولة بعد قليل.');
  } catch (error) {
    const message = error instanceof TypeError || error.name === 'TimeoutError'
      ? 'تعذر الاتصال بالخدمة. تحقق من الاتصال وأعد المحاولة.' : error.message;
    errorBox.textContent = message;
    errorBox.hidden = false;
    password.value = '';
    password.focus();
  } finally {
    submit.disabled = false;
    submitLabel.textContent = 'دخول إلى النظام';
    form.removeAttribute('aria-busy');
  }
});
