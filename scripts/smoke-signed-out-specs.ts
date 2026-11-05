/**
 * Locks signed-out specs (invariant 80, run 71d739 D8f).
 *
 * Run 8 shipped its catalogue, cart and contact specs on the `chromium`
 * project's storageState session (dependencies: ['setup']; each beforeEach
 * read "Session comes from playwright/.auth/user.json ... do not clear it"),
 * while every one of those recordings ran signed out with storage cleared
 * (invariant 4). Now only a feature whose every recording signed in at its
 * start (a leading login typing the test account by marker) runs on the
 * session; every other spec runs signed out, as recorded.
 *
 * A fixture site whose cart differs for a signed-in user ("Your saved cart
 * has 2 items") and a signed-out one ("Your cart is empty"). The report:
 * the happy login (feature account), an orders scenario that signed in
 * first, and a cart scenario recorded signed out.
 *   A. the emitted framework, TS and JS: the cart spec runs in a project with
 *      no storageState and clears state per test; the orders spec runs on the
 *      session and lost its leading login; the login spec keeps its own.
 *   B. Playwright runs both frameworks green against the fixture (setup,
 *      login, orders and cart).
 *   C. a report whose every non-login feature signed in keeps the old config
 *      byte for byte.
 * No network beyond 127.0.0.1, no model call.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { AUTH_ENV_PASS, AUTH_ENV_USER } from '../src/agent/auth-emit.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const USER = 'fixture.customer@shop.test';
const PASS = 'Fixture!Pass-2026';

/* ─── the fixture site ─────────────────────────────────────────────────────── */
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? '');
  if (url.pathname === '/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += String(d); });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (form.get('email') === USER && form.get('password') === PASS) {
        res.writeHead(302, { 'set-cookie': 'session=ok; Path=/', location: '/account' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page('Login', '<h1>Login</h1><p role="alert">Invalid email or password</p>'));
      }
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/auth/login') {
    res.end(page('Login', `<h1>Login</h1><form method="post" action="/auth/login">
<label for="email">Email</label><input id="email" name="email">
<label for="password">Password</label><input id="password" name="password" type="password">
<button type="submit" id="login">Login</button></form>`));
  } else if (url.pathname === '/account') {
    res.end(page('Account', signedIn ? '<h1>My account</h1>' : '<h1>Please sign in</h1>'));
  } else if (url.pathname === '/orders') {
    res.end(page('Orders', signedIn ? '<h1>Order history</h1>' : '<h1>Sign in to see your orders</h1>'));
  } else {
    res.end(page('Cart', `<h1>Cart</h1><p id="cart-status">${signedIn ? 'Your saved cart has 2 items' : 'Your cart is empty'}</p>`));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ─── the report ───────────────────────────────────────────────────────────── */
const nav = (url: string): TraceStep => ({ kind: 'navigate', url });
const marked = (css: string, intent: string, credential: 'user' | 'pass'): TraceStep => ({ kind: 'fill', target: { level: 'css', arg: css, intent }, value: '', credential } as TraceStep);
const click = (css: string, intent: string): TraceStep => ({ kind: 'click', target: { level: 'css', arg: css, intent } });
const assertUrl = (pattern: string): TraceStep => ({ kind: 'assert', name: 'url', assertion: { type: 'toHaveURL', pattern, timeout: 10000 } } as TraceStep);
const contains = (css: string, intent: string, text: string): TraceStep => ({ kind: 'assert', name: intent, assertion: { type: 'toContainText', target: { level: 'css', arg: css, intent }, text, timeout: 10000 } } as TraceStep);
const LOGIN: TraceStep[] = [
  nav(`${base}/auth/login`),
  marked('#email', 'email input', 'user'),
  marked('#password', 'password input', 'pass'),
  click('#login', 'login button'),
  assertUrl('/account'),
];
const sc = (name: string, feature: string, steps: TraceStep[]): Scenario => ({ name, category: 'happy', feature, steps } as Scenario);
const scenarios: Scenario[] = [
  sc('logged in with the test account and landed on the account page', 'account', [...LOGIN]),
  sc('signed in and saw the order history', 'orders', [...LOGIN, nav(`${base}/orders`), contains('h1', 'orders heading', 'Order history')]),
  sc('opened the cart and saw it empty', 'cart', [nav(`${base}/cart`), contains('#cart-status', 'cart status', 'Your cart is empty')]),
];
const report = (language: 'ts' | 'js', list: Scenario[] = scenarios): RunReport => ({
  url: `${base}/cart`, language, scenarios: list,
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
} as RunReport);

const prevUser = process.env[AUTH_ENV_USER];
const prevPass = process.env[AUTH_ENV_PASS];
const dirs: string[] = [];
try {
  /* ─── A. the emitted framework ─────────────────────────────────────────── */
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    const e = emitFramework(report(language), 'POM', 'signed-out');
    dirs.push(e.dir);
    emitted.push(e);
    const ext = language;
    const config = e.files.get(`playwright.config.${ext}`) ?? '';
    const projectBlock = (name: string): string => { const i = config.indexOf(`name: '${name}'`); return i < 0 ? '' : config.slice(i, config.indexOf('},', config.indexOf('}', i) + 1) + 2); };
    const signedIn = projectBlock('signed-in');
    const chromium = projectBlock('chromium');
    console.log(`   ${language} config projects:\n${config.slice(config.indexOf('projects: ['), config.indexOf('\n  ],', config.indexOf('projects: [')) + 5).split('\n').map((l) => `     ${l}`).join('\n')}`);
    check(`A1. ${language}: the cart spec runs in the chromium project, which has no storageState and no setup dependency`,
      chromium !== '' && !chromium.includes('storageState') && !chromium.includes('dependencies') && chromium.includes("'**/orders/**'") && !chromium.includes("'**/cart/**'"), chromium);
    check(`A2. ${language}: only the orders spec runs on the session (signed-in project: storageState, dependencies on setup, testMatch orders)`,
      signedIn.includes('storageState: "playwright/.auth/user.json"') && signedIn.includes("dependencies: ['setup']") && signedIn.includes(`testMatch: ['orders/**/*.spec.${ext}']`), signedIn);
    const cart = e.files.get(`tests/cart/cart.spec.${ext}`) ?? '';
    const orders = e.files.get(`tests/orders/orders.spec.${ext}`) ?? '';
    const account = e.files.get(`tests/account/account.spec.${ext}`) ?? '';
    check(`A3. ${language}: the signed-out cart spec has no storageState and clears cookies and storage per test, as the recording ran`,
      !cart.includes('storageState') && cart.includes('await context.clearCookies();') && !cart.includes('do not clear it'), cart.slice(0, 600));
    check(`A4. ${language}: the orders spec lost its leading login and keeps the session`,
      !orders.includes(AUTH_ENV_PASS) && !orders.includes('clearCookies') && orders.includes('do not clear it'), orders.slice(0, 600));
    check(`A5. ${language}: the login spec keeps its full login with env references and clears state`, account.includes(`process.env.${AUTH_ENV_USER} ?? ''`) && account.includes('clearCookies'));
  }

  /* ─── B. Playwright, against the fixture ───────────────────────────────── */
  process.env[AUTH_ENV_USER] = USER;
  process.env[AUTH_ENV_PASS] = PASS;
  const runs = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, '.') })));
  for (const { e, res } of runs) {
    const byTitle = (t: string) => res.specs.find((sp) => sp.title.includes(t));
    console.log(`   ${e.language}: playwright exit ${String(res.status)}; ${res.specs.map((sp) => `${sp.title}: ${sp.status}`).join('; ')}`);
    check(`B1. ${e.language}: Playwright exits 0 with every test expected`, res.status === 0 && res.specs.length >= 4 && res.specs.every((sp) => sp.status === 'expected'), res.out);
    check(`B2. ${e.language}: the signed-out cart test passes against the cart a signed-out user sees`, byTitle('saw it empty')?.status === 'expected', JSON.stringify(byTitle('saw it empty')));
    check(`B3. ${e.language}: the signed-in orders test passes on the session and the auth setup ran`, byTitle('order history')?.status === 'expected' && byTitle('authenticate')?.status === 'expected', JSON.stringify([byTitle('order history'), byTitle('authenticate')]));
  }

  /* ─── C. every recording signed in: the old config, byte for byte ──────── */
  const allIn = emitFramework(report('ts', scenarios.slice(0, 2)), 'POM', 'signed-in-only');
  dirs.push(allIn.dir);
  const cfg = allIn.files.get('playwright.config.ts') ?? '';
  check('C1. with every non-login recording signed in, the config is the pre-change one (main project chromium on the session, no signed-in project)',
    cfg.includes(`    // Everything else starts authenticated via the saved storage state.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: "playwright/.auth/user.json" },
      dependencies: ['setup'],
      testIgnore: ['**/account/**', '**/auth.setup.*'],
    },`) && !cfg.includes("name: 'signed-in'"), cfg);
} finally {
  if (prevUser === undefined) delete process.env[AUTH_ENV_USER]; else process.env[AUTH_ENV_USER] = prevUser;
  if (prevPass === undefined) delete process.env[AUTH_ENV_PASS]; else process.env[AUTH_ENV_PASS] = prevPass;
  server.close();
  cleanup(dirs);
}
for (const d of dirs) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: only specs whose every recording signed in run on the storageState session; the signed-out cart spec runs signed out and passes against a cart that differs for a signed-in user, TS and JS.');
