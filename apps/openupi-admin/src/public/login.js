(() => {
  'use strict';

  const form = document.getElementById('signin-form');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const toggle = document.getElementById('toggle-password');
  const submit = document.getElementById('signin-submit');
  const errorBox = document.getElementById('signin-error');
  const spinner = submit.querySelector('.spinner');
  const label = submit.querySelector('.btn-label');

  let pending = false;

  const setError = message => {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  };

  const setPending = value => {
    pending = value;
    submit.disabled = value;
    spinner.hidden = !value;
    label.textContent = value ? 'Signing in…' : 'Sign in';
  };

  toggle.addEventListener('click', () => {
    const showing = password.type === 'text';
    password.type = showing ? 'password' : 'text';
    toggle.textContent = showing ? 'Show' : 'Hide';
    toggle.setAttribute('aria-pressed', String(!showing));
    password.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;

    const user = username.value.trim();
    const pass = password.value;
    if (!user || !pass) {
      setError('Enter your username and password.');
      (user ? password : username).focus();
      return;
    }

    setError('');
    setPending(true);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });

      let body = null;
      try { body = await res.json(); } catch { body = null; }

      if (res.ok) {
        window.location.replace('/');
        return;
      }

      if (res.status === 429) {
        setError(body?.message || 'Too many attempts. Wait a few minutes and try again.');
      } else if (res.status === 403) {
        setError('This request was blocked. Open the admin on its HTTPS address and try again.');
      } else if (res.status === 401) {
        setError('Invalid username or password.');
      } else {
        setError(body?.message || 'Sign-in is unavailable right now. Try again.');
      }
      password.select();
    } catch {
      setError('Cannot reach the OpenUPI admin. Check the connection and try again.');
    } finally {
      setPending(false);
    }
  });

  username.focus();
})();
