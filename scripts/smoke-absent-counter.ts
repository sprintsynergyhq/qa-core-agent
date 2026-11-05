/**
 * Locks the absent counter (invariant 80, run 71d739 D5a).
 *
 * Run 8's product page has no cart badge before the first add: RULE 9
 * refused a count capture, a text capture of the badge could not resolve, and
 * "capture the badge text, add, assert_compare greater" could never be
 * recorded, so R6 dropped on a fix the page cannot satisfy. Now a text
 * capture, or a compare re-read, on a counter target (RULE 9's
 * isCounterSelector) that matches no element reads "0" and the step records
 * absentAsZero: true. Any other absent target fails loudly, as before.
 *
 * A fixture product page renders the badge only after the first add (300 ms
 * after the click). In broken mode the add does nothing, so the badge never
 * appears. A remove button takes the cart back to empty (the badge goes).
 *   A. the tool: capture before the add reads "0" (css and testid hints),
 *      add, compare greater passes; broken, the compare FAILS; a non-counter
 *      absent target still fails at capture with nothing recorded; a present
 *      counter records no flag; capture "1", remove, compare less passes,
 *      with and without the badge's hints on the compare.
 *   B. replay: the recorded scenario passes, and FAILS in broken mode; the
 *      remove scenario passes.
 *   C. the emitted spec, POM and single file, TS and JS, run with Playwright:
 *      the cart-count test passes, and FAILS in broken mode; the helper is
 *      written only when a step uses it; the TS helper compiles strict.
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { ABSENT_COUNTER_GRACE_MS, renderAbsentCounterHelper } from '../src/agent/absent-counter.js';
import { describeStep } from '../src/agent/critic.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture product page ─────────────────────────────────────────────── */
let broken = false;
const productHtml = (): string => `<!doctype html><html lang="en"><head><title>Pliers</title></head><body>
<nav><a href="/cart" data-test="nav-cart">Cart <span id="slot"></span></a></nav>
<main><h1 data-test="product-name">Combination Pliers</h1>
<button type="button" data-test="add-to-cart">Add to cart</button>
<button type="button" data-test="remove-all">Empty cart</button></main>
<script>
  const broken = ${broken};
  let count = 0;
  function render() {
    const slot = document.getElementById('slot');
    slot.innerHTML = count > 0 ? '<span data-test="cart-quantity">' + count + '</span>' : '';
  }
  document.querySelector('[data-test="add-to-cart"]').addEventListener('click', () => {
    if (broken) return;
    setTimeout(() => { count++; render(); }, 300);
  });
  document.querySelector('[data-test="remove-all"]').addEventListener('click', () => {
    setTimeout(() => { count = 0; render(); }, 300);
  });
</script></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url?.startsWith('/product') ? productHtml() : '<!doctype html><title>cart</title><h1>Cart</h1>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const PRODUCT = `${base}/product`;

const BADGE = '[data-test="cart-quantity"]';
const browser = await chromium.launch({ headless: true });
const dirs: string[] = [];

try {
  const ctxB = await browser.newContext();
  await installEvalShim(ctxB);
  const page = await ctxB.newPage();
  const tool = createContext(page, 400);
  const last = (): TraceStep | undefined => tool.current?.steps.at(-1);

  /* ─── A. the tool ───────────────────────────────────────────────────────── */
  const CART = 'added a product and the header cart count increased';
  await runTool(tool, { name: 'begin_scenario', input: { name: CART, category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'get_dom', input: {} });
  const t0 = Date.now();
  const cap = await runTool(tool, { name: 'capture', input: { name: 'badge', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  const waited = Date.now() - t0;
  const capStep = last();
  check('A1. a text capture on the absent badge reads "0" and records absentAsZero on the step',
    cap.ok && (cap.data as { value: string }).value === '0' && capStep?.kind === 'capture' && capStep.absentAsZero === true && capStep.target.level === 'css' && capStep.target.arg === BADGE,
    JSON.stringify({ cap, capStep }));
  check(`A2. the capture waited the counter grace (${ABSENT_COUNTER_GRACE_MS} ms) before reading "0", and no longer`, waited >= ABSENT_COUNTER_GRACE_MS && waited < ABSENT_COUNTER_GRACE_MS + 2500, `${waited} ms`);
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  const greater = await runTool(tool, { name: 'assert_compare', input: { name: 'badge', relation: 'greater', intent: 'cart badge after add' } });
  const cmpStep = last();
  check('A3. add, then assert_compare greater passes (the badge now reads "1")', greater.ok && cmpStep?.kind === 'assert_compare' && cmpStep.relation === 'greater', JSON.stringify(greater));
  check('A4. the compare re-reads the flagged counter, so it records absentAsZero too', cmpStep?.kind === 'assert_compare' && cmpStep.absentAsZero === true, JSON.stringify(cmpStep));
  const ended = await runTool(tool, { name: 'end_scenario', input: {} });
  const cartScenario = tool.scenarios.find((s) => s.name === CART) as Scenario | undefined;
  check('A5. end_scenario accepts the scenario (capture, add, compare greater)', ended.ok && !!cartScenario, JSON.stringify(ended));
  console.log(`   Critic line: ${describeStep(cartScenario!.steps.find((s) => s.kind === 'capture')!)}`);

  // A testid hint on a data-test host reads the host's attribute (hintBuiltRecord).
  await runTool(tool, { name: 'begin_scenario', input: { name: 'badge by testid', category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  const capTid = await runTool(tool, { name: 'capture', input: { name: 'badgeTid', source: 'text', testid: 'cart-quantity', intent: 'cart badge' } });
  const tidStep = last();
  check('A6. a testid hint on the absent badge reads "0" through the host test-id attribute (css [data-test="cart-quantity"])',
    capTid.ok && (capTid.data as { value: string }).value === '0' && tidStep?.kind === 'capture' && tidStep.absentAsZero === true && tidStep.target.arg === BADGE, JSON.stringify(tidStep));
  // A non-counter target that is absent fails loudly, as before.
  const before = tool.current?.steps.length ?? -1;
  const missing = await runTool(tool, { name: 'capture', input: { name: 'subtitle', source: 'text', css: '[data-test="product-subtitle"]', intent: 'product subtitle' } });
  check('A7. a NON-counter absent target still fails at capture, reads nothing as "0", records nothing', !missing.ok && (tool.current?.steps.length ?? -1) === before && !tool.captures.has('subtitle'), JSON.stringify(missing));
  // A present counter is read the usual way: no flag.
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  await page.waitForSelector(BADGE);
  const present = await runTool(tool, { name: 'capture', input: { name: 'badgeOne', source: 'text', css: BADGE, intent: 'cart badge after one add' } });
  const presentStep = last();
  check('A8. a counter on the page is read by its text with no flag (value "1")', present.ok && (present.data as { value: string }).value === '1' && presentStep?.kind === 'capture' && presentStep.absentAsZero === undefined, JSON.stringify(presentStep));
  // Capture "1", empty the cart (the badge goes), compare less: the absent re-read reads "0".
  await runTool(tool, { name: 'click', input: { testid: 'remove-all', intent: 'empty cart button' } });
  const less = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeOne', relation: 'less', intent: 'cart badge after emptying' } });
  const lessStep = last();
  check('A9. capture "1", empty the cart, compare less passes: the badge is gone and reads "0", the compare records absentAsZero',
    less.ok && lessStep?.kind === 'assert_compare' && lessStep.absentAsZero === true, JSON.stringify({ less, lessStep }));
  // The same compare naming the badge by its hints: an absent counter hint is
  // read off the hints, never resolved through the cascade (which would fail).
  const lessHints = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeOne', relation: 'less', css: BADGE, intent: 'cart badge after emptying' } });
  const lessHintsStep = last();
  check('A9b. the compare passing the absent badge\'s hints reads it as "0" too (never a could-not-resolve)',
    lessHints.ok && lessHintsStep?.kind === 'assert_compare' && lessHintsStep.absentAsZero === true, JSON.stringify({ lessHints }));
  await runTool(tool, { name: 'end_scenario', input: {} });
  const removeScenario = tool.scenarios.find((s) => s.name === 'badge by testid') as Scenario | undefined;

  // Broken add: the badge never appears, so the compare must FAIL.
  broken = true;
  await runTool(tool, { name: 'begin_scenario', input: { name: 'broken add', category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'capture', input: { name: 'badgeB', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  const brokenCmp = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeB', relation: 'greater', intent: 'cart badge after add' } });
  check('A10. broken add-to-cart: compare greater FAILS in the tool (captured "0", now "0")', !brokenCmp.ok && /captured "0", now "0"/.test(brokenCmp.error ?? ''), JSON.stringify(brokenCmp));
  broken = false;

  /* ─── B. replay ─────────────────────────────────────────────────────────── */
  const r1 = await replayScenarioOnce(browser, cartScenario!, undefined, 8000);
  check('B1. the recorded cart-count scenario replays green on a fresh context', r1.passed === true, JSON.stringify(r1));
  const r2 = await replayScenarioOnce(browser, removeScenario!, undefined, 8000);
  check('B2. the remove scenario (absent re-read after emptying) replays green', r2.passed === true, JSON.stringify(r2));
  broken = true;
  const r3 = await replayScenarioOnce(browser, cartScenario!, undefined, 4000);
  check('B3. broken add-to-cart: the same recording FAILS in replay at the compare', r3.passed === false && cartScenario!.steps[r3.failedStep ?? -1]?.kind === 'assert_compare', JSON.stringify(r3));
  broken = false;

  /* ─── C. the emitted spec ──────────────────────────────────────────────── */
  const TEST = 'added a product and the header cart count increased';
  const report = (language: 'ts' | 'js', scenarios: Scenario[]): RunReport => ({
    url: PRODUCT, language, scenarios,
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  } as RunReport);
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language, [cartScenario!]), shape, 'absent-counter');
      dirs.push(e.dir);
      emitted.push(e);
    }
  }
  for (const e of emitted) {
    const spec = [...e.files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y')).map(([, t]) => t).join('\n');
    const lines = spec.split('\n').map((l) => l.trim()).filter((l) => l.includes('readCounterText(') && !l.startsWith('async function') && !l.startsWith('//'));
    console.log(`   ${e.language} ${e.shape}:\n     ${lines.join('\n     ')}`);
    check(`C1. ${e.language} ${e.shape}: the capture reads through readCounterText with the ${ABSENT_COUNTER_GRACE_MS} ms grace and the compare polls readCounterText(…, 0)`,
      lines.some((l) => l.startsWith('const cap_badge = await readCounterText(') && l.includes(`, ${ABSENT_COUNTER_GRACE_MS});`))
      && lines.some((l) => l.startsWith('await expect.poll(async () => parseNumber(await readCounterText(') && l.includes(', 0)), { timeout: 10000 }).toBeGreaterThan(parseNumber(cap_badge));')), lines.join(' | '));
    if (e.shape === 'POM') {
      const helper = e.files.get(`helpers/absent-counter.${e.language}`);
      check(`C2. ${e.language} POM: helpers/absent-counter is written with the agent's own text and the spec imports it`,
        helper === renderAbsentCounterHelper(e.language) && (e.language === 'ts' ? spec.includes(`import { readCounterText } from '../../helpers/absent-counter';`) : spec.includes(`const { readCounterText } = require('../../helpers/absent-counter');`)), helper?.slice(0, 200));
      if (e.language === 'ts') {
        const tsc = spawnSync('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'helpers/absent-counter.ts'], { cwd: e.dir, encoding: 'utf8' });
        check('C3. ts POM: helpers/absent-counter.ts compiles under tsc --strict', tsc.status === 0, (tsc.stdout + tsc.stderr).slice(0, 400));
      }
    } else {
      check(`C2. ${e.language} single file: readCounterText is inlined`, spec.includes('async function readCounterText(locator, graceMs) {'));
    }
  }
  const plain = emitFramework(report('ts', [{ ...cartScenario!, steps: cartScenario!.steps.map((s) => (s.kind === 'capture' || s.kind === 'assert_compare') ? (({ absentAsZero: _a, ...rest }) => rest as TraceStep)(s) : s) }]), 'POM', 'absent-counter-plain');
  dirs.push(plain.dir);
  check('C4. a framework with no absentAsZero step has no helpers/absent-counter and no readCounterText anywhere', ![...plain.files.keys()].some((f) => f.includes('absent-counter')) && ![...plain.files.values()].some((t) => t.includes('readCounterText')));

  const runAll = async (label: string, expectPass: boolean): Promise<void> => {
    const runs = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'cart count increased') })));
    for (const { e, res } of runs) {
      const spec = res.specs.find((sp) => sp.title.includes(TEST));
      console.log(`   ${e.language} ${e.shape} ${broken ? 'broken add' : 'working add'}: playwright exit ${String(res.status)}; ${spec?.status ?? 'missing'}`);
      check(`${label}. ${e.language} ${e.shape}: with ${broken ? 'a broken' : 'a working'} add-to-cart the emitted cart-count test ${expectPass ? 'passes' : 'FAILS'}`,
        expectPass ? res.status === 0 && spec?.status === 'expected' : res.status !== 0 && spec?.status === 'unexpected', JSON.stringify(spec) + ' | ' + res.out);
    }
  };
  await runAll('C5', true);
  broken = true;
  await runAll('C6', false);
  broken = false;
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: an absent counter reads "0" in the tool, replay and the emitted spec (POM and single file, TS and JS); a broken add fails in all of them; a non-counter absent target still fails at capture.');
