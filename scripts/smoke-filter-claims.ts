/**
 * Locks invariant 79's first rule (run 71d739 D1): a universal claim is never
 * met by an empty list.
 *
 * Run 8 shipped "[happy] filtered by Hammer subcategory and only hammers
 * remained": the Hammer checkbox emptied the list, and the only check of the
 * claim was a count 0 on [data-test='product-name']:not(:has-text("Hammer")),
 * which holds on an empty list. RULE 7 had refused the honest all-items form
 * because "Hammer" was not a value the scenario typed, and it never read the
 * literal the Explorer then put inside the selector.
 *
 * A fixture filter page lists Claw Hammer, Long Nose Pliers, Thor Hammer and
 * Saw. Checking the Hammer checkbox, choosing the Hammer option of the
 * category select, or checking the Hammer radio re-renders the list 300 ms
 * later, by route:
 *   /empty     nothing (run 8's shape)
 *   /hammers   Claw Hammer and Thor Hammer
 *   /filter    the current mode, so ONE emitted test runs in both
 *
 *   A. the tool: the checkbox's visible label is recorded on the step; an
 *      allItemsMatch on the checked label passes on two hammers and records
 *      ONE step with the escaped label and flags i, the end gate accepts it;
 *      on the empty list it is refused with nothing recorded; a select's
 *      chosen option label and a radio's label count the same way; a label
 *      that was unchecked again, or never chosen, is refused by RULE 7.
 *   B. replay: the recording passes on two hammers and FAILS on the empty
 *      list.
 *   C. the emitted spec, TS and JS, POM and single file, run with Playwright:
 *      it passes on two hammers and FAILS on the empty list.
 *   D. RULE 7 reads literals inside a css selector: run 8's selector is
 *      refused at the tool before any probe (nothing recorded) and by the end
 *      gate on run 8's recorded steps; :text(), text=, a [title] value and a
 *      price inside :has-text() on a catalogue structure are refused; a
 *      literal on a heading, an alert or a button is not.
 * No network beyond 127.0.0.1, no model call.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { runGate, selectorLiteralReason, selectorLiterals } from '../src/agent/gate.js';
import { allItemsPollLine, chosenLabels } from '../src/agent/all-items.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
const AFTER: Record<string, string[]> = { '/empty': [], '/hammers': ['Claw Hammer', 'Thor Hammer'] };
const pageFor = (after: string[]): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hand tools</title></head><body><main>
<h1>Hand tools</h1>
<fieldset><legend>Category</legend>
<label><input type="checkbox" name="cat" value="hammer"> Hammer</label>
<label><input type="checkbox" name="cat" value="pliers"> Pliers</label>
</fieldset>
<label for="cat-select">Category list</label>
<select id="cat-select"><option value="">All</option><option value="c1">Hammer</option><option value="c2">Pliers</option></select>
<fieldset><legend>Only</legend><label><input type="radio" name="only" value="h"> Hammer only</label></fieldset>
<section id="results" aria-label="results"></section>
<script>
function render(list) {
  const r = document.getElementById('results');
  r.innerHTML = '';
  for (const n of list) {
    const a = document.createElement('a'); a.className = 'card'; a.href = '#';
    const h = document.createElement('h5'); h.setAttribute('data-test', 'product-name'); h.textContent = n;
    a.appendChild(h); r.appendChild(a);
  }
}
render(['Claw Hammer', 'Long Nose Pliers', 'Thor Hammer', 'Saw']);
const apply = () => setTimeout(() => render(${JSON.stringify(after)}), 300);
for (const el of document.querySelectorAll('input, select')) el.addEventListener('change', apply);
</script></main></body></html>`;
let mode = '/hammers';
const server = http.createServer((req, res) => {
  const route = (req.url ?? '/').split('?')[0]!;
  const after = route === '/filter' ? AFTER[mode] : AFTER[route];
  if (!after) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageFor(after));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ITEMS = '[data-test="product-name"]';
const RUN8_SELECTOR = `[data-test='product-name']:not(:has-text("Hammer"))`;
const asserts = (steps: TraceStep[]): TraceStep[] => steps.filter((st) => st.kind === 'assert');
const ok = (calls: Array<{ ok: boolean }>): boolean => calls.every((c) => c.ok);

const browser = await chromium.launch({ headless: true });
const dirs: string[] = [];
try {
  /** One tool context on a route: begin, navigate, the choice calls, then the assert. */
  const drive = async (route: string, choices: Array<{ name: string; input: Record<string, unknown> }>, assertInput: Record<string, unknown>) => {
    const bctx = await browser.newContext();
    await installEvalShim(bctx);
    const page = await bctx.newPage();
    const ctx = createContext(page, 40);
    const setup = [
      await runTool(ctx, { name: 'begin_scenario', input: { name: 'filtered by Hammer and only hammers remained', category: 'happy', feature: 'catalogue' } }),
      await runTool(ctx, { name: 'navigate', input: { url: `${base}${route}` } }),
    ];
    for (const c of choices) setup.push(await runTool(ctx, c));
    const t0 = Date.now();
    const asserted = await runTool(ctx, { name: 'assert', input: { intent: 'product names', timeout: 5000, ...assertInput } });
    return { ctx, bctx, setup, asserted, ms: Date.now() - t0 };
  };
  const checkHammer = { name: 'set_checked', input: { intent: 'Hammer category filter', role: 'checkbox', label: 'Hammer', checked: true } };
  const allHammer = { type: 'allItemsMatch', css: ITEMS, text: 'hammer' };

  /* ─── A. the tool ─────────────────────────────────────────────────────── */
  const hammers = await drive('/hammers', [checkHammer], allHammer);
  const steps = hammers.ctx.current?.steps ?? [];
  const checked = steps.find((st) => st.kind === 'set_checked');
  check('A0. the setup calls (begin, navigate, check Hammer) all succeeded', ok(hammers.setup), JSON.stringify(hammers.setup));
  check('A1. the tool reads the checkbox\'s visible label off the page and records it on the step', checked?.kind === 'set_checked' && checked.label === 'Hammer' && checked.checked === true, JSON.stringify(checked));
  check('A2. on two hammers the all-items assertion on the checked label passes, one read of 2 items',
    hammers.asserted.ok === true && (hammers.asserted.data as { items?: number }).items === 2, JSON.stringify(hammers.asserted));
  const last = steps.at(-1);
  const recorded = last?.kind === 'assert' && last.assertion.type === 'allItemsMatch' ? last.assertion : null;
  check('A3. it records ONE step after the check: the escaped label "Hammer" (never the model\'s "hammer"), flags exactly i',
    asserts(steps).length === 1 && steps.at(-2)?.kind === 'set_checked' && recorded?.pattern === 'Hammer' && recorded.flags === 'i' && recorded.target.arg === ITEMS, JSON.stringify(recorded));
  const ended = await runTool(hammers.ctx, { name: 'end_scenario', input: {} });
  check('A4. end_scenario accepts it: the end gate\'s RULE 7 finds the checked label', ended.ok === true && hammers.ctx.scenarios.length === 1, JSON.stringify(ended));
  const scenario: Scenario = JSON.parse(JSON.stringify(hammers.ctx.scenarios[0]!)) as Scenario;
  await hammers.bctx.close();

  const empty = await drive('/empty', [checkHammer], allHammer);
  check('A5. on the empty list (run 8\'s shape) the same assertion is refused, 0 items, nothing recorded',
    ok(empty.setup) && empty.asserted.ok === false && (empty.asserted.error ?? '').startsWith('allItemsMatch refused: product names matches no item, and "every item matches /Hammer/i" proves nothing on an empty list (last read: 0 items).') && asserts(empty.ctx.current?.steps ?? []).length === 0,
    empty.asserted.error);
  await empty.bctx.close();

  const select = await drive('/hammers', [{ name: 'select_option', input: { intent: 'category list', css: '#cat-select', optionValue: 'c1' } }], allHammer);
  const selStep = (select.ctx.current?.steps ?? []).find((st) => st.kind === 'select_option');
  check('A6. a select chosen by its value records the chosen option\'s visible label, and the all-items assertion on that label passes',
    ok(select.setup) && selStep?.kind === 'select_option' && selStep.label === 'Hammer' && select.asserted.ok === true, JSON.stringify({ selStep, asserted: select.asserted }));
  await select.bctx.close();

  const radio = await drive('/hammers', [{ name: 'set_checked', input: { intent: 'hammer only radio', css: 'input[name="only"]', checked: true } }], { ...allHammer, text: 'Hammer only' });
  const radioStep = (radio.ctx.current?.steps ?? []).find((st) => st.kind === 'set_checked');
  check('A7. a radio located by css records its wrapping label ("Hammer only"); that label is accepted by RULE 7 and the probe then judges the list (no item matches "Hammer only")',
    ok(radio.setup) && radioStep?.kind === 'set_checked' && radioStep.label === 'Hammer only' && radio.asserted.ok === false && /^allItemsMatch: product names has 2 item\(s\); not matching \/Hammer only\/i/.test(radio.asserted.error ?? ''),
    JSON.stringify({ radioStep, asserted: radio.asserted }));
  await radio.bctx.close();

  const unchecked = await drive('/hammers', [checkHammer, { name: 'set_checked', input: { intent: 'Hammer category filter', role: 'checkbox', label: 'Hammer', checked: false } }], allHammer);
  check('A8. a label checked and then unchecked is no longer chosen: RULE 7 refuses it with the label named in the steer, before any probe',
    ok(unchecked.setup) && unchecked.asserted.ok === false && (unchecked.asserted.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "hammer" on ') && (unchecked.asserted.error ?? '').includes('or the label of a filter it checked or selected') && unchecked.ms < 2000,
    unchecked.asserted.error);
  await unchecked.bctx.close();

  const notChosen = await drive('/hammers', [checkHammer], { ...allHammer, text: 'Pliers' });
  check('A9. a label the scenario never chose ("Pliers") is refused by RULE 7, nothing recorded',
    notChosen.asserted.ok === false && (notChosen.asserted.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "Pliers"') && asserts(notChosen.ctx.current?.steps ?? []).length === 0, notChosen.asserted.error);
  await notChosen.bctx.close();

  const fromLocator = chosenLabels([{ kind: 'set_checked', target: { level: 'role', arg: { role: 'checkbox', name: 'Hammer', exact: true }, intent: 'x' }, checked: true }]);
  check('A10. a step recorded before the label field reads the locator\'s own name (run 8\'s recorded checkbox)', JSON.stringify(fromLocator) === '["Hammer"]', JSON.stringify(fromLocator));

  /* ─── B. replay ───────────────────────────────────────────────────────── */
  const onRoute = (s: Scenario, route: string): Scenario => ({
    ...JSON.parse(JSON.stringify(s)) as Scenario,
    steps: (JSON.parse(JSON.stringify(s.steps)) as TraceStep[]).map((st) => (st.kind === 'navigate' ? { ...st, url: `${base}${route}` } : st)),
  });
  const allIdx = scenario.steps.findIndex((st) => st.kind === 'assert' && st.assertion.type === 'allItemsMatch');
  const rHammers = await replayScenarioOnce(browser, onRoute(scenario, '/hammers'), undefined, 10_000);
  const rEmpty = await replayScenarioOnce(browser, onRoute(scenario, '/empty'), undefined, 10_000);
  check('B1. replay passes the recording on two hammers', rHammers.passed === true, rHammers.error);
  check('B2. replay FAILS it on the empty list, at the allItemsMatch step, naming 0 items',
    rEmpty.passed === false && rEmpty.failedStep === allIdx && rEmpty.error === 'allItemsMatch: "product names" has 0 item(s); not matching /Hammer/i: []', JSON.stringify(rEmpty));

  /* ─── C. the emitted spec, run ────────────────────────────────────────── */
  const report = (language: 'ts' | 'js'): RunReport => ({
    url: `${base}/filter`, language,
    scenarios: [{ ...onRoute(scenario, '/filter'), name: 'filtered by Hammer and only hammers remained' }],
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  });
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language), shape, 'filter-claims');
      dirs.push(e.dir);
      emitted.push(e);
    }
  }
  for (const e of emitted) {
    const spec = [...e.files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y')).map(([, t]) => t).join('\n');
    const line = spec.split('\n').map((l) => l.trim()).find((l) => l.includes('.allTextContents()')) ?? '';
    const items = /\(await (.+?)\.allTextContents\(\)\)/.exec(line)?.[1] ?? '(no items expression)';
    check(`C1. ${e.language} ${e.shape}: the spec checks the Hammer box, then writes the one all-items poll on the checked label`,
      line === allItemsPollLine(items, '/Hammer/i', 'i', 10000) && /\.check\(\)/.test(spec), line);
  }
  const runMode = async (m: string) => {
    mode = m;
    return Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'only hammers remained') })));
  };
  for (const { e, res } of await runMode('/hammers')) {
    const spec = res.specs.find((sp) => /only hammers remained/.test(sp.title));
    check(`C2. ${e.language} ${e.shape}: on two hammers the emitted test passes`, res.status === 0 && spec?.status === 'expected', JSON.stringify(spec) + ' | ' + res.out);
  }
  for (const { e, res } of await runMode('/empty')) {
    const spec = res.specs.find((sp) => /only hammers remained/.test(sp.title));
    check(`C3. ${e.language} ${e.shape}: on the empty list the same emitted test FAILS and prints the empty read`,
      res.status !== 0 && spec?.status === 'unexpected' && spec.error.includes('Received: "{\\"items\\":0,\\"notMatching\\":[]}"'), JSON.stringify(spec));
  }

  /* ─── D. RULE 7 reads literals inside a css selector ──────────────────── */
  const absent = await drive('/empty', [checkHammer], { type: 'toHaveCount', css: RUN8_SELECTOR, count: 0 });
  check('D1. run 8\'s count 0 on [data-test=\'product-name\']:not(:has-text("Hammer")) is refused by RULE 7 at the tool, before any probe, nothing recorded',
    absent.asserted.ok === false && (absent.asserted.error ?? '') === `RULE 7 (literal catalogue value) rejected this assertion: "Hammer" in :has-text() on ${RUN8_SELECTOR} is catalogue data that changes when the data reseeds; a literal inside a selector is an expected value: capture the value, act, assert_compare, or for every item of a list a filter or search narrowed, assert allItemsMatch on the item locator with the value typed or the label checked.` && absent.ms < 2000 && asserts(absent.ctx.current?.steps ?? []).length === 0,
    `${absent.asserted.error} (${absent.ms} ms)`);
  await absent.bctx.close();
  const visibleLit = await drive('/hammers', [], { type: 'toBeVisible', css: `${ITEMS}:text("Claw Hammer")` });
  check('D2. a toBeVisible on :text("Claw Hammer") inside a product-name selector is refused the same way', visibleLit.asserted.ok === false && /^RULE 7 \(literal catalogue value\) rejected this assertion: "Claw Hammer" in :text\(\) on /.test(visibleLit.asserted.error ?? ''), visibleLit.asserted.error);
  await visibleLit.bctx.close();
  const heading = await drive('/hammers', [], { type: 'toBeVisible', css: 'h1:has-text("Hand tools")', intent: 'page heading' });
  check('D3. a literal inside a heading selector is not catalogue data: recorded and passing', heading.asserted.ok === true, heading.asserted.error);
  await heading.bctx.close();

  // Run 8's recorded steps (scenarios[9], the repair pass), through the end gate.
  const css = (arg: string, intent: string): SelectorRecord => ({ level: 'css', arg, intent });
  const box: SelectorRecord = { level: 'role', arg: { role: 'checkbox', name: 'Hammer', exact: true }, intent: 'Hammer subcategory checkbox' };
  const run8: TraceStep[] = [
    { kind: 'navigate', url: 'http://localhost:4200/category/hand-tools' },
    { kind: 'capture', varName: 'cap_count', source: 'count', intent: 'product count', target: css("[data-test='product-name']", 'product names') },
    { kind: 'set_checked', target: box, checked: true },
    { kind: 'assert_compare', varName: 'cap_count', readVar: 'cap_count_now', relation: 'less', source: 'count', intent: 'product count', target: css("[data-test='product-name']", 'product names') },
    { kind: 'assert', name: 'no non-hammer', assertion: { type: 'toHaveCount', target: css(RUN8_SELECTOR, 'non-Hammer product names'), count: 0, timeout: 10000 } },
    { kind: 'assert', name: 'box checked', assertion: { type: 'toBeChecked', target: box, checked: true, timeout: 10000 } },
  ];
  const g = runGate({ name: 'filtered by Hammer subcategory and only hammers remained', category: 'happy', steps: run8 });
  check('D4. the end gate rejects run 8\'s recorded trace at the count-0 step (RULE 7, the backstop)', g.violations.some((v) => v.rule === 7 && v.stepIndex === 4 && v.detail.includes('"Hammer" in :has-text()')), JSON.stringify(g.violations));
  const withAllItems: TraceStep[] = [...run8.slice(0, 4), { kind: 'assert', name: 'every hammer', assertion: { type: 'allItemsMatch', target: css("[data-test='product-name']", 'product names'), pattern: 'Hammer', flags: 'i', timeout: 10000 } }, run8[5]!];
  const g2 = runGate({ name: 'filtered by Hammer subcategory and only hammers remained', category: 'happy', steps: withAllItems });
  check('D5. the same trace with allItemsMatch on the checked label instead passes the gate', !g2.violations.some((v) => v.rule === 7), JSON.stringify(g2.violations));

  const reasonFor = (arg: string): string | null => selectorLiteralReason({ level: 'css', arg, intent: 'x' });
  check('D6. the literal forms are read: :has-text, :text, :text-is, text=, and a text attribute value',
    JSON.stringify(selectorLiterals(`.card:has-text('A') >> text="B"`).map((l) => [l.literal, l.where])) === '[["A",":has-text()"],["B","text="]]'
    && JSON.stringify(selectorLiterals('[data-test="product-name"][title="Claw Hammer"]:text-is("C")').map((l) => [l.literal, l.where])) === '[["C",":text-is()"],["Claw Hammer","[title]"]]'
    && selectorLiterals('[data-test="product-name"][name="email"]#x').length === 0,
    JSON.stringify(selectorLiterals(`.card:has-text('A') >> text="B"`)));
  check('D7. refused on a catalogue structure: a [title] product name, text= under a card, a price inside :has-text on any non-message structure, a digit on a badge',
    reasonFor('[data-test="product-name"][title="Claw Hammer"]') !== null && reasonFor('.card >> text="Thor Hammer"') !== null
    && reasonFor('span:has-text("$14.15")') !== null && /literal count on a counter/.test(reasonFor('.badge:has-text("1")') ?? ''));
  check('D8. allowed: a heading, an alert, a button label, a structural attribute, no literal at all',
    reasonFor('h1:has-text("Hand tools")') === null && reasonFor('.alert:has-text("Invalid email or password")') === null
    && reasonFor('button:has-text("Login")') === null && reasonFor('[data-test="product-name"]') === null && reasonFor('input[name="email"]') === null);
  // The source keeps one parser: the gate's RULE 7 path calls the selector check first.
  const gateSrc = fs.readFileSync('src/agent/gate.ts', 'utf8');
  check('D9. catalogueLiteralReason reads the selector literal before the expected value, for every assertion type with a target',
    /if \('target' in a\) \{\n\s+const inSelector = selectorLiteralReason\(a\.target\);/.test(gateSrc));
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a filter claim is met only by one all-items read: the checked or selected label is a value allItemsMatch may name, the check passes on two hammers and FAILS on the empty list in the tool, replay and the emitted spec (TS and JS, POM and single file), and RULE 7 refuses run 8\'s count 0 with "Hammer" inside :has-text() at the tool and the gate.');
