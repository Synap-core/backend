/**
 * The pod-host first-admin page the CLI opens (`/setup?token=…`, hub-protocol
 * rest/setup.ts). It takes only whether a token is present: the page reads the
 * token from its own URL. It used to paste the query string into an inline
 * <script>, a reflected XSS on the pod origin once the TLS edge forwarded
 * every route (2026-10-19).
 */
export function renderSetupPage(hasToken: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Synap — First Admin Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: 100%;
      max-width: 400px;
      padding: 40px 36px;
      background: #111;
      border: 1px solid #222;
      border-radius: 12px;
    }
    .logo {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      font-size: 13px;
      color: #666;
      margin-bottom: 32px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #888;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    input {
      width: 100%;
      padding: 10px 14px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      color: #e5e5e5;
      font-size: 14px;
      margin-bottom: 18px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #444; }
    button {
      width: 100%;
      padding: 11px;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      margin-top: 4px;
    }
    button:hover { opacity: 0.88; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .error-msg {
      display: none;
      background: #2a1010;
      border: 1px solid #5a2020;
      border-radius: 8px;
      color: #f87171;
      font-size: 13px;
      padding: 10px 14px;
      margin-top: 16px;
    }
    .success-msg {
      display: none;
      background: #0f2a1a;
      border: 1px solid #1a5a2a;
      border-radius: 8px;
      color: #4ade80;
      font-size: 13px;
      padding: 24px 20px;
      margin-top: 8px;
    }
    .err-page { text-align: center; }
    .err-page h2 { font-size: 18px; color: #f87171; margin-bottom: 12px; }
    .err-page p { font-size: 13px; color: #666; line-height: 1.6; }
    code { background: #1a1a1a; border-radius: 4px; padding: 2px 6px; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
${
  hasToken
    ? `
<div class="card">
  <div class="logo">Synap</div>
  <div class="subtitle">Create your first admin account</div>
  <form id="form">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required placeholder="admin@example.com" />
    <label for="name">Name (optional)</label>
    <input id="name" name="name" type="text" autocomplete="name" placeholder="Your name" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required placeholder="Choose a strong password" />
    <button id="btn" type="submit">Create account</button>
    <div id="err" class="error-msg"></div>
    <div id="ok" class="success-msg"></div>
  </form>
  <script>
    document.getElementById('form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      const ok = document.getElementById('ok');
      err.style.display = 'none';
      ok.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/hub/setup/first-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            name: document.getElementById('name').value.trim() || undefined,
            password: document.getElementById('password').value,
            magicToken: new URLSearchParams(location.search).get('token') || '',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          err.textContent = data.error || 'Something went wrong.';
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Create account';
        } else {
          document.getElementById('form').style.display = 'none';
          document.querySelector('.subtitle').style.display = 'none';
          ok.innerHTML = \`
            <div style="text-align:center;padding:8px 0 4px">
              <div style="font-size:36px;margin-bottom:12px">✓</div>
              <div style="font-size:15px;font-weight:600;color:#4ade80;margin-bottom:8px">Admin account created</div>
              <div style="font-size:13px;color:#888;line-height:1.6">
                You can close this tab.<br/>
                Your terminal will continue automatically.
              </div>
            </div>
          \`;
          ok.style.display = 'block';
        }
      } catch (ex) {
        err.textContent = 'Network error — please try again.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Create account';
      }
    });
  </script>
</div>
`
    : `
<div class="card err-page">
  <div class="logo">Synap</div>
  <h2>Invalid setup link</h2>
  <p>This link is missing a valid token.<br/>Run <code>eve setup admin</code> on your server to generate a new one.</p>
</div>
`
}
</body>
</html>`;
}
