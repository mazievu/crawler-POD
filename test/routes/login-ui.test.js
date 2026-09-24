'use strict';

/**
 * test/routes/login-ui.test.js
 *
 * Gap #7: exercises public/app.js's login/auth-barrier UI logic against a
 * minimal DOM shim (no jsdom dependency — not already a devDependency, and
 * the surface under test doesn't need a full DOM engine):
 *   - 401 from /api/auth/me shows the login overlay
 *   - Login posts to /api/auth/login with credentials:'same-origin' and an
 *     x-requested-with header
 *   - apiFetch() sends x-requested-with on every call
 *   - Errors are rendered via textContent (not innerHTML), so they can never
 *     be interpreted as markup
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS_PATH = path.join(__dirname, '..', '..', 'public', 'app.js');
const APP_JS_SOURCE = fs.readFileSync(APP_JS_PATH, 'utf8');

/** Escapes the same way the browser's textContent->innerHTML round trip does. */
function htmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal element shim: enough surface for app.js's login-overlay/error paths. */
function createElementShim() {
  let _textContent = '';
  let _innerHTML = '';
  return {
    value: '',
    style: {},
    disabled: false,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    get textContent() { return _textContent; },
    set textContent(v) { _textContent = v == null ? '' : String(v); _innerHTML = htmlEscape(_textContent); },
    get innerHTML() { return _innerHTML; },
    set innerHTML(v) { _innerHTML = v == null ? '' : String(v); },
  };
}

/**
 * Builds a fresh sandbox (document/window/fetch/location shim) and loads
 * app.js into it via vm, returning handles test code needs.
 */
function loadAppJsSandbox({ fetchImpl }) {
  const elements = {
    'login-form': createElementShim(),
    'login-email': createElementShim(),
    'login-password': createElementShim(),
    'login-error': createElementShim(),
    'login-overlay': createElementShim(),
    'user-info-container': createElementShim(),
  };
  elements['login-email'].value = 'user@example.com';
  elements['login-password'].value = 'CorrectPassword123!';

  // app.js registers SEVERAL independent DOMContentLoaded listeners (one per
  // feature area) — the browser fires all of them, and unrelated ones must
  // not crash just because this shim doesn't model their feature's DOM.
  const domContentLoadedHandlers = [];
  let submitHandler = null;

  elements['login-form'].addEventListener = (event, cb) => {
    if (event === 'submit') submitHandler = cb;
  };

  const document_ = {
    // Auto-vivify any id this shim doesn't explicitly model, so DOMContentLoaded
    // listeners unrelated to login (wiring up unrelated inputs, etc.) can run
    // without throwing on a missing element — only the login-specific elements
    // above are asserted against.
    getElementById: (id) => {
      if (!elements[id]) elements[id] = createElementShim();
      return elements[id];
    },
    addEventListener: (event, cb) => {
      if (event === 'DOMContentLoaded') domContentLoadedHandlers.push(cb);
    },
    createElement: () => createElementShim(),
  };

  const fetchCalls = [];
  const fetchImplWrapped = (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };

  const sandbox = {
    document: document_,
    window: {},
    location: { reload: () => {} },
    fetch: fetchImplWrapped,
    console,
    feather: { replace: () => {} },
    bootstrap: { Modal: { getInstance: () => null } },
    confirm: () => true,
    alert: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS_SOURCE, sandbox, { filename: 'app.js' });

  return {
    sandbox,
    elements,
    fetchCalls,
    // Fires only the FIRST registered DOMContentLoaded listener — that is the
    // login-form + checkAuth() handler this test suite targets. Later
    // listeners wire up unrelated feature areas (collect form, search, etc.)
    // that would call apiFetch()/loadData() and pull in far more surface than
    // this login-focused suite needs.
    runFirstDomContentLoadedHandler: async () => {
      assert.ok(domContentLoadedHandlers.length > 0, 'app.js must register at least one DOMContentLoaded listener');
      await domContentLoadedHandlers[0]();
    },
    getSubmitHandler: () => submitHandler,
  };
}

test('checkAuth(): 401 from /api/auth/me shows the login overlay', async () => {
  const { sandbox, elements } = loadAppJsSandbox({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/auth/me');
      return { status: 401, ok: false, json: async () => ({}) };
    },
  });

  elements['login-overlay'].style.display = 'none';
  const isAuth = await sandbox.checkAuth();

  assert.equal(isAuth, false);
  assert.equal(elements['login-overlay'].style.display, 'flex', 'Login overlay must be shown on 401');
});

test('checkAuth(): /api/auth/me sends x-requested-with and same-origin credentials', async () => {
  let capturedOpts;
  const { sandbox } = loadAppJsSandbox({
    fetchImpl: async (url, opts) => {
      capturedOpts = opts;
      return { status: 200, ok: true, json: async () => ({ user: { email: 'a@b.com', role: 'member' } }) };
    },
  });

  await sandbox.checkAuth();

  assert.equal(capturedOpts.credentials, 'same-origin');
  assert.equal(capturedOpts.headers['x-requested-with'], 'XMLHttpRequest');
});

test('Login form submit: posts to /api/auth/login with credentials same-origin and x-requested-with header', async () => {
  let capturedUrl;
  let capturedOpts;
  const { getSubmitHandler, runFirstDomContentLoadedHandler, sandbox } = loadAppJsSandbox({
    fetchImpl: async (url, opts) => {
      if (url === '/api/auth/login') {
        capturedUrl = url;
        capturedOpts = opts;
        return { status: 200, ok: true, json: async () => ({ message: 'Login successful' }) };
      }
      // checkAuth() call after DOMContentLoaded — keep it out of the way.
      return { status: 401, ok: false, json: async () => ({}) };
    },
  });

  await runFirstDomContentLoadedHandler();
  const submit = getSubmitHandler();
  assert.ok(typeof submit === 'function', 'Submit handler must be registered');

  await submit({ preventDefault() {} });

  assert.equal(capturedUrl, '/api/auth/login');
  assert.equal(capturedOpts.credentials, 'same-origin');
  assert.equal(capturedOpts.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(capturedOpts.method, 'POST');
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.email, 'user@example.com');
  assert.equal(body.password, 'CorrectPassword123!');
});

test('Login form submit: failure renders the server message via textContent, never innerHTML markup', async () => {
  const maliciousMessage = '<img src=x onerror=alert(1)>';
  const { getSubmitHandler, runFirstDomContentLoadedHandler, elements } = loadAppJsSandbox({
    fetchImpl: async (url) => {
      if (url === '/api/auth/login') {
        return { status: 401, ok: false, json: async () => ({ message: maliciousMessage }) };
      }
      return { status: 401, ok: false, json: async () => ({}) };
    },
  });

  await runFirstDomContentLoadedHandler();
  await getSubmitHandler()({ preventDefault() {} });

  // textContent setter (shim) mirrors the browser: setting textContent with
  // markup characters produces an ESCAPED innerHTML, proving the real
  // assignment target is textContent and not innerHTML.
  assert.equal(elements['login-error'].textContent, maliciousMessage);
  assert.equal(
    elements['login-error'].innerHTML.includes('<img'),
    false,
    'Error message must never be interpreted as HTML markup'
  );
  assert.ok(elements['login-error'].innerHTML.includes('&lt;img'));
});

test('apiFetch(): every call sends x-requested-with and same-origin credentials', async () => {
  let capturedOpts;
  const { sandbox } = loadAppJsSandbox({
    fetchImpl: async (url, opts) => {
      capturedOpts = opts;
      return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true }) };
    },
  });

  await sandbox.apiFetch('/api/platforms');

  assert.equal(capturedOpts.credentials, 'same-origin');
  assert.equal(capturedOpts.headers['x-requested-with'], 'XMLHttpRequest');
});

test('apiFetch(): 401 triggers the login overlay and rejects', async () => {
  const { sandbox, elements } = loadAppJsSandbox({
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => '{}' }),
  });

  elements['login-overlay'].style.display = 'none';
  await assert.rejects(() => sandbox.apiFetch('/api/platforms'), /Unauthorized/);
  assert.equal(elements['login-overlay'].style.display, 'flex');
});
