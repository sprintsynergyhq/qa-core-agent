/**
 * Locks invariant 79's second rule (run 71d739 D2): the wrong-password
 * scenario never locks the dedicated account.
 *
 * Run 8 submitted 5 wrong passwords against the test account (explorer 1,
 * replay 1, stability 3) under the default cap of 10 and locked it; its
 * happy login survived replay only because it ran before the wrong-password
 * executions. Now stability never re-runs a wrong-password scenario
 * (credential safety: it ran once in replay), the default cap is 3, and the
 * emitted framework runs the wrong-password test after the happy login in a
 * serial block.
 *
 * A fixture site locks an account after 3 failed logins in a row (a
 * successful login resets the count, as most sites do). Run 8's order (the
 * happy login three times, then the wrong password three times in a row in
 * stability) locks it.
 *
 *   A. A full $0 pipeline pass: the CLI as a child process against the
 *      fixture, a local stand-in for the Anthropic API (Planner, Explorer and
 *      Critic scripted, no request leaves the machine), with replay,
 *      stability 3 and the emitted-spec check. The account still signs in at
 *      the end; stability shows the skip line and records the scenario as
 *      skipped, never stable or flaky; both tests ship; the wrong-password
 *      count is explorer 1, replay 1, emitted 1 under the default cap of 3.
 *   B. The emitted framework from the zip: the account spec runs the happy
 *      login, then the wrong-password test, inside one describe in serial
 *      mode; the README says the wrong-password test submits one failed login
 *      per suite run; run twice with Playwright on the fixture, both runs
 *      pass and the account still signs in.
 *   C. The default cap is 3, QA_CORE_WRONG_PASSWORD_CAP still overrides it.
 *   E. Both emitters in both languages write the serial block, happy login
 *      first; a wrong-password test tagged with another feature lands in the
 *      happy login's spec; a report with no wrong-password test has neither
 *      the block nor the README note.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { RunReport } from '../src/agent/trace.js';
import { CREDENTIAL_SAFETY_SKIP_REASON, WRONG_PASSWORD_CAP_DEFAULT, wrongPasswordCap } from '../src/agent/test-credentials.js';
import { LOGIN_SEQUENCE_TITLE, SERIAL_MODE_LINE } from '../src/agent/login-order.js';
import { startFakeAnthropic, type FakeAnthropicScript } from './lib/fake-anthropic.js';
import { runPlaywright, readTree } from './lib/emitted-runner.js';
import { scaffold } from '../src/agent/scaffold.js';
import { transcribe } from '../src/agent/transcriber.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const USER = 'lock.fixture@example.test';
const PASS = 'Fixture-Pass-77';
const agentCwd = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-lockout-'));

/* ─── the fixture site: locks after 3 failed logins in a row ─────────────── */
const state = { failures: 0, locked: false, wrongSubmits: 0, goodSubmits: 0 };
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const loginForm = (alert: string): string => page('Login', `<h1>Login</h1>${alert}<form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Login</button></form>`);
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
  if (u.pathname === '/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      const f = new URLSearchParams(raw);
      if (state.locked) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(loginForm('<div class="alert" role="alert">Account locked</div>'));
        return;
      }
      if (f.get('email') === USER && f.get('password') === PASS) {
        state.failures = 0; state.goodSubmits++;
        res.writeHead(303, { location: '/account' });
        res.end();
        return;
      }
      state.wrongSubmits++;
      state.failures++;
      if (state.failures >= 3) state.locked = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(loginForm('<div class="alert" role="alert">Invalid email or password</div>'));
    });
    return;
  }
  if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(loginForm('')); return; }
  if (u.pathname === '/account') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('My account', '<h1>My account</h1><p>Signed in.</p>')); return; }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Shop', '<h1>Shop</h1><a href="/login">Sign in</a>')); return; }
  res.writeHead(404); res.end('not found');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
/** Does the account sign in right now? A real form post, the way the site sees it. */
const signsIn = async (): Promise<boolean> => {
  const r = await fetch(`${site}/login`, { method: 'POST', body: new URLSearchParams({ email: USER, password: PASS }), redirect: 'manual' });
  return r.status === 303 && r.headers.get('location') === '/account';
};

/* ─── C. the default cap ─────────────────────────────────────────────────── */
check('C1. the default wrong-password cap is 3, and the source says so', WRONG_PASSWORD_CAP_DEFAULT === 3 && wrongPasswordCap({}).cap === 3 && wrongPasswordCap({}).capSource === 'default 3', JSON.stringify(wrongPasswordCap({})));
check('C2. QA_CORE_WRONG_PASSWORD_CAP still overrides the default', wrongPasswordCap({ QA_CORE_WRONG_PASSWORD_CAP: '5' }).cap === 5);

/* ─── the scripted model ─────────────────────────────────────────────────── */
const HAPPY = 'logged in with valid credentials';
const WRONG = 'rejected a wrong password and stayed on the login page';
const DASH = '—';
const plannerScript = [`<plan>\n1. [account][happy] ${HAPPY} ${DASH} fails if sign-in breaks\n2. [account][negative] ${WRONG} ${DASH} fails if a wrong password is accepted\n</plan>`];
const explorerScript: FakeAnthropicScript['explorer'] = [
  [{ type: 'tool_use', name: 'begin_scenario', input: { name: HAPPY, category: 'happy', feature: 'account' } }],
  [{ type: 'tool_use', name: 'navigate', input: { url: `${site}/login` } }],
  [{ type: 'tool_use', name: 'fill', input: { intent: 'email input', css: '#email', credential: 'user' } }],
  [{ type: 'tool_use', name: 'fill', input: { intent: 'password input', css: '#password', credential: 'pass' } }],
  [{ type: 'tool_use', name: 'click', input: { intent: 'login button', role: 'button', label: 'Login' } }],
  [{ type: 'tool_use', name: 'assert', input: { type: 'toHaveURL', pattern: '/account', timeout: 10000 } }],
  [{ type: 'tool_use', name: 'end_scenario', input: {} }],
  [{ type: 'tool_use', name: 'begin_scenario', input: { name: WRONG, category: 'negative', feature: 'account' } }],
  [{ type: 'tool_use', name: 'navigate', input: { url: `${site}/login` } }],
  [{ type: 'tool_use', name: 'fill', input: { intent: 'email input', css: '#email', credential: 'user' } }],
  [{ type: 'tool_use', name: 'fill', input: { intent: 'password input', css: '#password', value: 'wrong-password-1' } }],
  [{ type: 'tool_use', name: 'click', input: { intent: 'login button', role: 'button', label: 'Login' } }],
  [{ type: 'tool_use', name: 'assert', input: { type: 'toContainText', css: '.alert', intent: 'login error', text: 'Invalid email or password', timeout: 10000 } }],
  [{ type: 'tool_use', name: 'end_scenario', input: {} }],
  [{ type: 'tool_use', name: 'finish', input: { summary: 'both login scenarios recorded' } }],
];
const criticScript = [`[\n  { "scenario": "${HAPPY}", "verdict": "pass", "reasons": ["the URL after sign-in is asserted"], "required_fixes": [] },\n  { "scenario": "${WRONG}", "verdict": "pass", "reasons": ["the error text is asserted"], "required_fixes": [] }\n]\n<summary>Both login scenarios assert their outcome.</summary>`];

/** The child's environment: the fixture account under the host-scoped pair, nothing else from the parent's QA_CORE_ or ANTHROPIC_ names. */
function childEnv(baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('QA_CORE_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  return { ...env, ANTHROPIC_API_KEY: 'fixture-key-never-sent', ANTHROPIC_BASE_URL: baseUrl, QA_CORE_TEST_USER_127_0_0_1: USER, QA_CORE_TEST_PASS_127_0_0_1: PASS };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string; runDir: string | null; cwd: string }> {
  const cwd = path.join(tmpRoot, 'cli');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(agentCwd, 'src/cli/explore.ts'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      const project = path.join(cwd, 'output', '127-0-0-1');
      const runs = fs.existsSync(project) ? fs.readdirSync(project).filter((d) => d !== 'latest' && d !== 'latest.json' && fs.statSync(path.join(project, d)).isDirectory()) : [];
      resolve({ code, stdout, stderr, runDir: runs.length === 1 ? path.join(project, runs[0]!) : null, cwd });
    });
  });
}

try {
  /* ─── A. the full $0 pipeline pass ────────────────────────────────────── */
  const api = await startFakeAnthropic({ planner: plannerScript, explorer: explorerScript, critic: criticScript });
  let report: RunReport | null = null;
  let zipPath: string | null = null;
  try {
    const run = await runCli([`${site}/login`, '--replay', '--stability', '3'], childEnv(api.baseUrl));
    console.log(`  A run: exit ${String(run.code)}; model calls ${JSON.stringify(api.calls)}; fixture ${JSON.stringify(state)}`);
    if (run.code !== 0) console.log(run.stdout.slice(-4000), run.stderr.slice(-3000));
    check('A0. the run completes (exit 0), every scripted Explorer call returned ok and every scripted call was made',
      run.code === 0 && api.toolErrors.length === 0 && api.calls.explorer === explorerScript!.length && api.calls.planner === 1 && api.calls.critic === 1 && api.calls.other === 0,
      JSON.stringify({ code: run.code, errors: api.toolErrors, calls: api.calls }));
    if (run.runDir) {
      report = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run-report.json'), 'utf8')) as RunReport;
      zipPath = fs.readdirSync(run.runDir).filter((f) => f.endsWith('.zip')).map((f) => path.join(run.runDir!, f))[0] ?? null;
    }
    const out = run.stdout + run.stderr;
    check('A1. the account still signs in at the end of the pipeline (the fixture never locked it), and the post-run check says so',
      state.locked === false && await signsIn() && out.includes('post-run login check: the test account still signs in after 3 wrong-password attempts') && report?.lockoutWarning === undefined,
      JSON.stringify({ state, lockoutWarning: report?.lockoutWarning }));
    const skipLine = `Stability: "${WRONG}" not re-run (${CREDENTIAL_SAFETY_SKIP_REASON}); it ships on its replay pass and is not counted as stable or flaky`;
    check('A2. stability shows the skip line for the wrong-password scenario, once', out.split('\n').filter((l) => l.trim() === skipLine).length === 1, out.split('\n').filter((l) => l.includes('not re-run')).join(' | '));
    const v = report?.stability?.verdicts.find((x) => x.name === WRONG);
    const hv = report?.stability?.verdicts.find((x) => x.name === HAPPY);
    check('A3. the report records it as skipped with the reason, never stable or flaky; the happy login ran its 3 iterations',
      v?.classification === 'skipped' && v.skippedReason === CREDENTIAL_SAFETY_SKIP_REASON && v.passes === 0 && hv?.classification === 'stable' && hv.passes === 3
      && report?.stability?.passed === 1 && report.stability.flaked === 0 && report.stability.flakeRate === 0 && report.stability.credentialSafetySkipped === 1,
      JSON.stringify(report?.stability));
    check('A4. the console summary says it apart from stable and flaked', /Stability: {5}1\/1 stable across 3× · flake_rate=0\.0% · 1 not re-run \(credential safety: wrong-password scenarios run once in replay; not counted as stable or flaky\)/.test(out),
      out.split('\n').filter((l) => l.startsWith('Stability:')).join(' | '));
    check('A5. both tests ship and the funnel balances; the wrong-password scenario passed replay once',
      report?.scenarios.map((s) => s.name).join('|') === `${HAPPY}|${WRONG}` && report.reconciliation?.balanced === true && report.reconciliation.dropped.length === 0
      && report.replay?.verdicts.find((x) => x.name === WRONG)?.passed === true,
      JSON.stringify({ shipped: report?.scenarios.map((s) => s.name), rec: report?.reconciliation }));
    const ledger = report?.wrongPasswordAttempts;
    check('A6. the wrong-password count is explorer 1, replay 1, emitted 1, none at stability, under the default cap of 3',
      ledger?.cap === 3 && ledger.capSource === 'default 3' && ledger.count === 3 && JSON.stringify(ledger.byStage) === JSON.stringify({ explorer: 1, replay: 1, emitted: 1 }) && ledger.refused.length === 0 && state.wrongSubmits === 3,
      JSON.stringify({ ledger, state }));
    const emittedTests = report?.emittedRun?.tests ?? [];
    check('A7. the emitted-spec check ran the framework and both login tests passed',
      report?.emittedRun?.inconclusive !== true && emittedTests.some((t) => t.name.includes(HAPPY) && t.status === 'passed') && emittedTests.some((t) => t.name.includes(WRONG) && t.status === 'passed'),
      JSON.stringify(report?.emittedRun));
  } finally {
    await api.close();
  }

  /* ─── B. the emitted framework, run twice ─────────────────────────────── */
  check('B0. the run wrote its framework zip', zipPath !== null && fs.existsSync(zipPath), String(zipPath));
  if (zipPath) {
    const unzipDir = path.join(tmpRoot, 'framework');
    fs.mkdirSync(unzipDir, { recursive: true });
    const unz = spawnSync('unzip', ['-q', zipPath, '-d', unzipDir], { encoding: 'utf8' });
    const root = fs.readdirSync(unzipDir).map((d) => path.join(unzipDir, d)).find((d) => fs.existsSync(path.join(d, 'package.json')));
    check('B1. the zip extracts to a framework folder', unz.status === 0 && !!root, unz.stderr);
    if (root) {
      const files = readTree(root);
      const specFile = [...files.keys()].find((f) => /tests\/account\/account\.spec\.ts$/.test(f)) ?? '';
      const spec = files.get(specFile) ?? '';
      const describeAt = spec.indexOf(`test.describe(${JSON.stringify(LOGIN_SEQUENCE_TITLE)}`);
      const serialAt = spec.indexOf(SERIAL_MODE_LINE);
      const happyAt = spec.indexOf(`test("[happy] ${HAPPY}"`);
      const wrongAt = spec.indexOf(`test("[negative] ${WRONG}"`);
      check('B2. the account spec runs both login tests in one nested describe in serial mode, the happy login first',
        describeAt > 0 && serialAt > describeAt && happyAt > serialAt && wrongAt > happyAt, spec.slice(Math.max(0, describeAt - 400), describeAt + 900));
      const readme = files.get([...files.keys()].find((f) => f.endsWith('README.md')) ?? '') ?? '';
      check('B3. the README says the wrong-password test submits one failed login per suite run, after the happy login in serial mode',
        readme.includes(`The wrong-password test ("${WRONG}") submits one failed login per suite run against the account in \`.env\`. It runs after the happy login in serial mode`), readme.slice(0, 3000));
      check('B4. the README\'s Verification block names the test stability did not re-run',
        readme.includes('- except 1 wrong-password test, which ran once in replay and was not re-run by stability (credential safety'), readme);
      fs.symlinkSync(path.join(agentCwd, 'node_modules'), path.join(root, 'node_modules'), 'dir');
      process.env.QA_CORE_TEST_USER = USER;
      process.env.QA_CORE_TEST_PASS = PASS;
      for (const n of [1, 2]) {
        const res = await runPlaywright(root, '.');
        const failed = res.specs.filter((s) => s.status !== 'expected');
        console.log(`  B run ${n}: playwright exit ${String(res.status)}; ${res.specs.length} test(s); fixture ${JSON.stringify(state)}`);
        check(`B${4 + n}. framework run ${n}: every test passes (the login pair included) and the account still signs in`,
          res.status === 0 && res.specs.some((s) => s.title.includes(HAPPY)) && res.specs.some((s) => s.title.includes(WRONG)) && failed.length === 0 && state.locked === false && await signsIn(),
          JSON.stringify({ failed, state, out: res.out.slice(-800) }));
      }
      delete process.env.QA_CORE_TEST_USER;
      delete process.env.QA_CORE_TEST_PASS;
    }
  }

  /* ─── E. both emitters, both languages, and a wrong-password test in another feature ─ */
  if (report) {
    for (const language of ['ts', 'js'] as const) {
      for (const shape of ['POM', 'single file'] as const) {
        const r: RunReport = { ...report, language };
        const dir = fs.mkdtempSync(path.join(tmpRoot, `emit-${language}-${shape === 'POM' ? 'pom' : 'single'}-`));
        if (shape === 'POM') scaffold({ report: r, outDir: dir, siteName: 'lock-fixture' });
        else transcribe({ report: r, outDir: dir, name: 'lock-fixture' });
        const files = readTree(dir);
        const spec = [...files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y') && (shape === 'single file' || f.includes('account'))).map(([, t]) => t).join('\n');
        const at = (needle: string): number => spec.indexOf(needle);
        const d = at(`test.describe(${JSON.stringify(LOGIN_SEQUENCE_TITLE)}`);
        check(`E1. ${language} ${shape}: the happy login and the wrong-password test sit in one serial describe, happy first`,
          d > 0 && SERIAL_MODE_LINE === "test.describe.configure({ mode: 'serial' });" && at(SERIAL_MODE_LINE) > d && at(`[happy] ${HAPPY}`) > at(SERIAL_MODE_LINE) && at(`[negative] ${WRONG}`) > at(`[happy] ${HAPPY}`), spec.slice(0, 1500));
      }
    }
    // The wrong-password test tagged with another feature lands beside the happy login.
    const moved: RunReport = { ...report, scenarios: report.scenarios.map((sc) => (sc.name === WRONG ? { ...sc, feature: 'auth' } : sc)) };
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'emit-moved-'));
    scaffold({ report: moved, outDir: dir, siteName: 'lock-fixture' });
    const tree = readTree(dir);
    const accountSpec = tree.get('tests/account/account.spec.ts') ?? '';
    check('E2. a wrong-password test tagged with another feature is emitted in the happy login\'s spec, in the serial block, and no spec of its own',
      accountSpec.includes(`[negative] ${WRONG}`) && accountSpec.indexOf(`[negative] ${WRONG}`) > accountSpec.indexOf(SERIAL_MODE_LINE) && ![...tree.keys()].some((f) => f.startsWith('tests/auth/')), [...tree.keys()].filter((f) => f.startsWith('tests/')).join(', '));
    // No wrong-password test: the spec is emitted exactly as before.
    const plain: RunReport = { ...report, scenarios: report.scenarios.filter((sc) => sc.name !== WRONG), ...(report.stability ? { stability: { ...report.stability, credentialSafetySkipped: undefined } } : {}) };
    const pdir = fs.mkdtempSync(path.join(tmpRoot, 'emit-plain-'));
    scaffold({ report: plain, outDir: pdir, siteName: 'lock-fixture' });
    const ptree = readTree(pdir);
    check('E3. with no wrong-password test there is no serial block and no README note', !(ptree.get('tests/account/account.spec.ts') ?? '').includes(SERIAL_MODE_LINE) && !(ptree.get('README.md') ?? '').includes('wrong-password test'));
  }

  /* ─── D. run 8's stability order locks the fixture (the control) ──────── */
  // The fixture is not lenient: the happy login three times (resetting the
  // count) then the wrong password three times in a row locks it.
  state.failures = 0; state.locked = false;
  for (let i = 0; i < 3; i++) await signsIn();
  for (let i = 0; i < 3; i++) await fetch(`${site}/login`, { method: 'POST', body: new URLSearchParams({ email: USER, password: `wrong-${i}` }), redirect: 'manual' });
  const lockedNow = (): boolean => state.locked;
  check('D1. control: run 8\'s stability order (3 happy, then 3 wrong in a row) locks the fixture account', lockedNow() && !(await signsIn()), JSON.stringify(state));
} finally {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: on a fixture that locks after 3 failed logins in a row, a full $0 pipeline pass ends with the account still signing in: stability does not re-run the wrong-password scenario (skip line, recorded skipped, never stable or flaky), the default cap is 3, and the emitted framework runs the wrong-password test after the happy login in serial mode, twice, with the account still signing in.');
