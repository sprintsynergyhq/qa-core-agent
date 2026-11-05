/**
 * Locks findings across the repair pass (invariant 80, run 71d739 D6).
 *
 * Run 8: after filling quantity 0 and Add to cart, the badge appeared and
 * "count unchanged" failed with Expected 0, Received 1, once in the main pass
 * and once in the repair. The repair ran in a new tool context whose retry
 * count started at 0, so neither failure reached the cap and no finding was
 * recorded; the scenario dropped at the critic stage. Now the repair starts
 * from the main pass's counts, a compare whose relation does not hold counts
 * toward the same cap as an assert, and a product finding the repair records
 * is the run's finding: the scenario leaves the drop bucket.
 *
 * A fixture product page: quantity 0 still adds 1 item (the badge appears
 * with "1" and a status line says "Product added to shopping cart.").
 *   A. run 8's shape: toHaveCount 0 on the badge, failing once in the main
 *      pass (the scenario then closes on another assertion), the Critic asks
 *      for the count check, and the repair asserts it again: one finding.
 *   B. the doctrine shape: capture the absent badge text ("0", invariant 80),
 *      fill 0, add, assert_compare unchanged, failing once in each pass: one
 *      finding.
 *   In both: kind product (never a locator failure), the expected outcome,
 *   the page's status line and the check's own Expected / Received in the
 *   finding; the scenario is in reconciliation.findings, not in dropped; the
 *   funnel balances; the journey on review.repair is marked finding.
 *   C. the Explorer prompt line beside the existing finding guidance.
 * $0: no model call, no network beyond 127.0.0.1.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { explore, EXPLORER_SYSTEM_PROMPT, type AgentEvent, type ReviewPaused } from '../src/agent/runtime.js';
import type { critique as realCritique, CriticResult, ScenarioVerdict } from '../src/agent/critic.js';
import { findingKindOf } from '../src/agent/finding-kind.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_')) delete process.env[k];
process.env.ANTHROPIC_API_KEY ??= 'fixture-key-never-sent';

/* ─── the fixture: quantity 0 still adds an item ───────────────────────────── */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><head><title>Pliers</title></head><body>
<nav><a href="/cart" data-test="nav-cart">Cart <span id="slot"></span></a></nav>
<main><h1 data-test="product-name">Combination Pliers</h1>
<label for="quantity-input">Quantity</label><input id="quantity-input" data-test="quantity" type="number" min="1" max="99" value="1">
<button type="button" data-test="add-to-cart">Add to cart</button><div id="toast"></div></main>
<script>
  let count = 0;
  document.querySelector('[data-test="add-to-cart"]').addEventListener('click', () => {
    // The product behavior under review: a quantity of 0 still adds one item.
    // Synchronous, so a count-0 check right after the click reads the badge
    // (in run 8 the model's own latency covered the site's delay).
    count += Math.max(1, Number(document.getElementById('quantity-input').value) || 0);
    document.getElementById('slot').innerHTML = '<span data-test="cart-quantity">' + count + '</span>';
    document.getElementById('toast').innerHTML = '<div role="status">Product added to shopping cart.</div>';
  });
</script></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const PRODUCT = `http://127.0.0.1:${(server.address() as { port: number }).port}/product`;

const NAME = 'set quantity to zero, added to cart, the cart count remained unchanged';
const plan: PlannedScenario[] = [{ name: NAME, category: 'edge', rationale: 'r', feature: 'cart', ruleIds: ['R6'] }];
const BADGE = '[data-test="cart-quantity"]';
type Call = { name: string; input: Record<string, unknown> };
const opening: Call[] = [
  { name: 'begin_scenario', input: { name: NAME, category: 'edge', feature: 'cart' } },
  { name: 'navigate', input: { url: PRODUCT } },
  { name: 'get_dom', input: {} },
];
const addZero: Call[] = [
  { name: 'fill', input: { css: '#quantity-input', value: '0', intent: 'quantity input' } },
  { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } },
];
const countZero: Call = { name: 'assert', input: { type: 'toHaveCount', css: BADGE, count: 0, intent: 'cart badge', timeout: 5000 } };
const captureBadge: Call = { name: 'capture', input: { name: 'badge', source: 'text', css: BADGE, intent: 'cart badge before add' } };
const unchanged: Call = { name: 'assert_compare', input: { name: 'badge', relation: 'unchanged', intent: 'cart badge after add' } };
const fallback: Call = { name: 'assert', input: { type: 'toBeVisible', testid: 'add-to-cart', intent: 'add to cart button', timeout: 10000 } };
const finish: Call = { name: 'finish', input: { summary: 'done' } };

function scriptedClient(script: Call[]): { client: Anthropic; used: () => number } {
  let n = 0;
  const client = {
    messages: {
      create: async () => {
        const call = script[n++];
        const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        if (!call) return { usage, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
        return { usage, content: [{ type: 'tool_use', id: `tu${n}`, name: call.name, input: call.input }], stop_reason: 'tool_use' };
      },
    },
  } as unknown as Anthropic;
  return { client, used: () => n };
}

const FIX = 'assert the cart count stayed unchanged after adding with quantity 0';
const fixtureCritic: typeof realCritique = async (opts) => {
  const verdicts: ScenarioVerdict[] = opts.repairFixes
    ? []
    : opts.scenarios.map((s) => ({ scenario: s.name, verdict: 'rework', reasons: ['the planned outcome, an unchanged cart count, is never asserted'], required_fixes: [FIX] }));
  return { verdicts, summary: 'fixture review', costUsd: 0.001, raw: '', unreviewed: [], warnings: [] } as CriticResult;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-repair-findings-'));
const agentCwd = process.cwd();
process.chdir(tmpRoot);

async function runShape(label: string, main: Call[], repair: Call[]): Promise<void> {
  const events: AgentEvent[] = [];
  const { client, used } = scriptedClient([...main, finish, ...repair, finish]);
  const r = await explore({
    url: PRODUCT, language: 'ts', outDir: path.join(tmpRoot, label), fromPlan: plan,
    model: 'claude-opus-4-7', maxUsd: 5, skipStability: true, stabilize: false, loginPreflightDone: true,
    explorerClient: client, critique: fixtureCritic, onEvent: (e) => events.push(e),
  });
  if ((r as ReviewPaused).paused) throw new Error('unexpected pause');
  const report = r as RunReport;
  const messages = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
  const findings = report.findings ?? [];
  const f = findings[0];
  const rec = report.reconciliation!;
  check(`${label}1. both loops ran every scripted call`, used() >= main.length + repair.length + 2, `${used()} calls; ${messages.slice(-6).join(' | ')}`);
  check(`${label}2. the run ends with exactly one finding, on the scenario`, findings.length === 1 && f?.scenario === NAME, JSON.stringify(findings));
  check(`${label}3. the finding is product behavior, never a locator failure`, !!f && findingKindOf(f) === 'product' && f.kind === 'product');
  check(`${label}4. the finding names the behavior: the page's status line and the check's own report`,
    !!f && f.messages.some((m) => m.includes('Product added to shopping cart.')) && /Received: "?1"?|now "1"/.test(f.failure ?? ''), JSON.stringify(f));
  check(`${label}5. the scenario is in reconciliation.findings and in no drop bucket`,
    rec.findings.some((x) => x.name === NAME) && !rec.dropped.some((d) => d.name === NAME) && !(rec.emitted_failed ?? []).some((d) => d.name === NAME), JSON.stringify({ dropped: rec.dropped, findings: rec.findings }));
  check(`${label}6. the funnel balances: 1 planned = 1 finding`, rec.balanced === true && rec.planned === 1 && rec.generated === 0, JSON.stringify({ planned: rec.planned, generated: rec.generated, balanced: rec.balanced }));
  const journey = report.review?.repair?.find((h) => h.scenario === NAME);
  check(`${label}7. review.repair marks the journey as a finding (not re-recorded, no second verdict)`, journey?.finding === true && journey.second === undefined, JSON.stringify(journey));
  const line = messages.find((m) => m.startsWith(`Finding: "${NAME}"`));
  check(`${label}8. the console prints the finding line with the check's report`, !!line && line.includes('The check reported:'), line ?? messages.filter((m) => m.includes('inding')).join(' | '));
  console.log(`   ${line ?? '(no finding line)'}`);
}

// C. the Explorer prompt says to assert the planned outcome as planned when the page contradicts it.
check('C1. the Explorer prompt says to record a finding when the page contradicts the expected outcome, beside the finding guidance',
  EXPLORER_SYSTEM_PROMPT.includes("When the page contradicts the scenario's expected outcome on a fresh load (for example, quantity 0 still adds an item), record a finding with the observed behavior: assert the planned outcome as planned, never rewrite the assertion to match what you saw")
  && EXPLORER_SYSTEM_PROMPT.includes('a finding is product behavior to review, never a test failure'));

try {
  // A. run 8's shape: toHaveCount 0 on the badge.
  await runShape('A', [...opening, ...addZero, countZero, fallback, { name: 'end_scenario', input: {} }], [...opening, ...addZero, countZero]);
  // B. the doctrine shape: capture the absent badge, act, compare unchanged.
  await runShape('B', [...opening, captureBadge, ...addZero, unchanged, fallback, { name: 'end_scenario', input: {} }], [...opening, captureBadge, ...addZero, unchanged]);
} finally {
  process.chdir(agentCwd);
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a check that fails once in the main pass and once in the repair records one product finding; the scenario is counted as a finding, never as a drop or a locator failure.');
