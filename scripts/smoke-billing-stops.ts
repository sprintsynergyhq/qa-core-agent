/**
 * Locks invariant 79's fifth rule (run 71d739 D7): a billing or credit error
 * from any stage stops the run, never a fallback.
 *
 * Run 8's attempt 1 hit "Your credit balance is too low" at its page filter,
 * printed "(deterministic fallback)" with no reason, and stopped one call
 * later at the Planner. The page filter and its explore() stop are locked in
 * smoke-page-filter (K); the Planner and the Explorer already stopped
 * (smoke-console-log E, smoke-failure-classify). This lock covers the rest,
 * each with run 8 attempt 1's billing error verbatim from a fixture client:
 *
 *   A. The requirements map: one call, no retry, the stop line (no
 *      checkpoint can exist yet, so none is claimed).
 *   B. The feature parser: the stop line, never an empty feature list; any
 *      other error passes through as itself.
 *   C. The Critic, through explore() on a local page: the run stops at once
 *      (stopped.haltedAt critic), no replay or stability runs, nothing ships
 *      unreviewed, each recorded scenario is incomplete with the reason, the
 *      funnel balances, the checkpoint holds the traces, and the empty-run
 *      diagnosis names the stop.
 *   D. The Stabilizer, through explore() on a page that flakes once in
 *      stability: proposeStabilityFix throws the billing error instead of
 *      "no proposal", and the run stops at once (haltedAt stabilizer):
 *      nothing ships unverified, nothing is dropped as broken.
 * No request leaves the machine.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { buildRequirementsMap } from '../src/agent/requirements.js';
import { parseFeatures } from '../src/agent/parse-features.js';
import { explore, type AgentEvent, type ReviewPaused } from '../src/agent/runtime.js';
import { proposeStabilityFix } from '../src/agent/stabilizer.js';
import { diagnoseEmptyRun } from '../src/agent/reconcile.js';
import { loadCheckpoint, stopBeforeRunMessage } from '../src/agent/checkpoint.js';
import type { critique as realCritique } from '../src/agent/critic.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

// Run 8 attempt 1's billing error, verbatim (output/localhost/20261102T125106Z-d2c5df, events line 13).
const BILLING_BODY = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }, request_id: 'req_011Cge8fAX6nGC9NzgNUVSgH' };
const billingError = (): Error => Object.assign(new Error(`400 ${JSON.stringify(BILLING_BODY)}`), { status: 400, error: BILLING_BODY });
const REASON = `billing/credit exhaustion (400 ${JSON.stringify(BILLING_BODY)})`;
const throwing = (make: () => Error) => {
  let calls = 0;
  return { calls: () => calls, client: { messages: { create: async () => { calls++; throw make(); } } } as unknown as Anthropic };
};

// Nothing may leave the machine: a stage that reached a real client would hit a closed local port.
for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_')) delete process.env[k];
process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

/* ─── A. the requirements map ──────────────────────────────────────────── */
{
  const t = throwing(billingError);
  let err: Error | null = null;
  try { await buildRequirementsMap({ srsText: '# Shop\nUsers log in.', apiKey: 'fake', client: t.client }); } catch (e) { err = e as Error; }
  check('A1. a billing error at the map stops with the stop line after ONE call (no retry, never "could not extract a map")',
    t.calls() === 1 && err?.message === stopBeforeRunMessage(REASON, 'requirements map') && err.message === `Run stopped: ${REASON}. Nothing was saved to resume: the requirements map runs before any run state exists; start the run again once the cause is fixed.`,
    `${t.calls()} call(s): ${err?.message}`);
  const other = throwing(() => new Error('not json at all'));
  let err2: Error | null = null;
  try { await buildRequirementsMap({ srsText: '# Shop', apiKey: 'fake', client: other.client }); } catch (e) { err2 = e as Error; }
  check('A2. any other error keeps the one retry and its own message', other.calls() === 2 && /^Could not extract a requirements map from the SRS/.test(err2?.message ?? ''), `${other.calls()} call(s): ${err2?.message}`);
}

/* ─── B. the feature parser ────────────────────────────────────────────── */
{
  const t = throwing(billingError);
  let err: Error | null = null;
  let result: unknown = null;
  try { result = await parseFeatures({ naturalInput: 'test login and cart', apiKey: 'fake', client: t.client }); } catch (e) { err = e as Error; }
  check('B1. a billing error at the feature parser stops with the stop line, never an empty feature list', result === null && err?.message === stopBeforeRunMessage(REASON, 'feature parser'), `${JSON.stringify(result)} ${err?.message}`);
  const other = throwing(() => new Error('socket hang up'));
  let err2: Error | null = null;
  try { await parseFeatures({ naturalInput: 'test login and cart', apiKey: 'fake', client: other.client }); } catch (e) { err2 = e as Error; }
  check('B2. any other error passes through as itself', err2?.message === 'socket hang up', err2?.message);
}

/* ─── the fixture site and the scripted Explorer ───────────────────────── */
let hits = 0;
let flakeOn = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname !== '/') { res.writeHead(404); res.end(''); return; }
  hits++;
  const heading = flakeOn > 0 && hits === flakeOn ? 'Closed' : 'Shop';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body><main><h1>${heading}</h1><p id="note">Welcome</p></main></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
type Call = { name: string; input: Record<string, unknown> };
const record = (name: string, assertInput: Record<string, unknown>): Call[] => [
  { name: 'begin_scenario', input: { name, category: 'happy', feature: 'shop' } },
  { name: 'navigate', input: { url: siteUrl } },
  { name: 'assert', input: { timeout: 10000, ...assertInput } },
  { name: 'end_scenario', input: {} },
];
const scripted = (script: Call[]): Anthropic => {
  let n = 0;
  return { messages: { create: async () => {
    const call = script[n++];
    const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!call) return { usage, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    return { usage, content: [{ type: 'tool_use', id: `tu${n}`, name: call.name, input: call.input }], stop_reason: 'tool_use' };
  } } } as unknown as Anthropic;
};
const HEADING = 'showed the shop heading';
const NOTE = 'showed the welcome note';
const plan: PlannedScenario[] = [
  { name: HEADING, category: 'happy', rationale: 'r', feature: 'shop' },
  { name: NOTE, category: 'happy', rationale: 'r', feature: 'shop' },
];
const script: Call[] = [
  ...record(HEADING, { type: 'toHaveText', role: 'heading', label: 'Shop', intent: 'shop heading', text: 'Shop' }),
  ...record(NOTE, { type: 'toBeVisible', css: '#note', intent: 'welcome note' }),
  { name: 'finish', input: { summary: 'two' } },
];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-billing-stops-'));
const agentCwd = process.cwd();
process.chdir(tmpRoot);
const runOnce = async (label: string, opts: { critique: typeof realCritique; stabilizerClient?: Anthropic; stability: boolean }) => {
  const events: AgentEvent[] = [];
  const outDir = path.join(tmpRoot, label);
  const r = await explore({
    url: siteUrl, language: 'ts', outDir, fromPlan: plan,
    model: 'claude-opus-4-7', maxUsd: 2, skipStability: !opts.stability, stabilize: true, maxStabilizeAttempts: 1, loginPreflightDone: true,
    explorerClient: scripted(script), critique: opts.critique,
    ...(opts.stabilizerClient ? { stabilizerClient: opts.stabilizerClient } : {}),
    onEvent: (e) => events.push(e),
  });
  if ((r as ReviewPaused).paused) throw new Error('unexpected pause');
  return { report: r as RunReport, events, outDir, messages: events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text) };
};

try {
  /* ─── C. the Critic ───────────────────────────────────────────────────── */
  {
    let criticCalls = 0;
    const billingCritic: typeof realCritique = async () => { criticCalls++; throw billingError(); };
    const c = await runOnce('critic', { critique: billingCritic, stability: true });
    const r = c.report;
    check('C1. the run stops at the Critic: stopped billing, haltedAt critic, the reason verbatim', criticCalls === 1 && r.stopped?.kind === 'billing' && r.stopped.haltedAt === 'critic' && r.stopped.reason === REASON, JSON.stringify(r.stopped));
    check('C2. nothing after it runs: no replay, no stability, nothing ships unreviewed', r.scenarios.length === 0 && r.replay === undefined && r.stability === undefined && !c.events.some((e) => e.type === 'replay_started' || e.type === 'stability_started'), JSON.stringify({ shipped: r.scenarios.length, replay: r.replay, events: c.events.map((e) => e.type).slice(-8) }));
    check('C3. each recorded scenario is incomplete with the reason; the funnel balances',
      JSON.stringify((r.incomplete ?? []).map((i) => [i.scenario, i.reason])) === JSON.stringify([[HEADING, `not reviewed: the run stopped at the Critic (${REASON})`], [NOTE, `not reviewed: the run stopped at the Critic (${REASON})`]]) && r.reconciliation?.balanced === true && r.reconciliation.planned === 2,
      JSON.stringify(r.incomplete));
    const stopLine = c.messages.find((m) => m.startsWith(`Run stopped: ${REASON}. State saved. Resume with: npm run explore -- --resume `));
    check('C4. the console prints the billing stop line and what did not run, never "Critic skipped"',
      !!stopLine && c.messages.includes('Stopped at the Critic: nothing after it runs (no replay, stability or framework); 2 scenario(s) recorded as incomplete, never shipped unreviewed.') && !c.messages.some((m) => m.startsWith('Critic skipped')), JSON.stringify(c.messages.slice(-5)));
    const cp = loadCheckpoint(path.join(c.outDir, 'checkpoint.json'));
    check('C5. the checkpoint holds both recorded traces, so a resume reviews them without re-exploring', cp.completedScenarios.map((s) => s.name).join('|') === `${HEADING}|${NOTE}`, JSON.stringify(cp.completedScenarios.map((s) => s.name)));
    const diag = diagnoseEmptyRun(r);
    check('C6. the empty-run diagnosis names the stop, never "the explorer recorded none"',
      diag?.cause === 'halted' && diag.lines[0] === `The run stopped at the Critic (${REASON}): nothing after it ran, so no scenario reached the framework.` && diag.lines[1] === `2 recorded scenario(s) wait in the checkpoint: "${HEADING}", "${NOTE}".`, JSON.stringify(diag));
  }

  /* ─── D. the Stabilizer ───────────────────────────────────────────────── */
  {
    // proposeStabilityFix itself: a billing error is thrown, never "no proposal".
    const t = throwing(billingError);
    let err: Error | null = null;
    try {
      await proposeStabilityFix({ scenario: { name: HEADING, category: 'happy', steps: [{ kind: 'navigate', url: siteUrl }] }, failure: { failedStep: 0, stepKind: 'navigate', error: 'x' }, pattern: 'P-F-P', client: t.client } as never);
    } catch (e) { err = e as Error; }
    check('D1. proposeStabilityFix throws the billing error instead of returning "no proposal"', t.calls() === 1 && /credit balance is too low/.test(err?.message ?? ''), err?.message);
    // Page loads in order: exploration (1, 2), replay (3, 4), then the
    // heading scenario's three stability iterations (5, 6, 7). Load 6 shows
    // "Closed": the heading scenario reads P-F-P, flaky, and goes to the
    // Stabilizer.
    hits = 0;
    flakeOn = 6;
    const passCritic: typeof realCritique = async (o) => ({ verdicts: o.scenarios.map((s) => ({ scenario: s.name, verdict: 'pass' as const, reasons: ['sound'], required_fixes: [] })), summary: 'all pass', costUsd: 0.001, raw: '', unreviewed: [], warnings: [] });
    const stab = throwing(billingError);
    const d = await runOnce('stabilizer', { critique: passCritic, stabilizerClient: stab.client, stability: true });
    const r = d.report;
    check('D2. the flake reached the Stabilizer, whose client got the billing error once', stab.calls() === 1 && d.events.some((e) => e.type === 'stability_iteration_failed'), `${stab.calls()} call(s); hits ${hits}`);
    check('D3. the run stops at the Stabilizer: stopped billing, haltedAt stabilizer', r.stopped?.kind === 'billing' && r.stopped.haltedAt === 'stabilizer' && r.stopped.reason === REASON, JSON.stringify(r.stopped));
    check('D4. nothing ships unverified, nothing is dropped as broken or flaky: every replay survivor is incomplete with the reason, the funnel balances',
      r.scenarios.length === 0 && r.stability === undefined && (r.reconciliation?.dropped ?? []).length === 0
      && JSON.stringify((r.incomplete ?? []).map((i) => i.reason)) === JSON.stringify([`not re-run in stability: the run stopped at the Stabilizer (${REASON})`, `not re-run in stability: the run stopped at the Stabilizer (${REASON})`]) && r.reconciliation?.balanced === true,
      JSON.stringify({ incomplete: r.incomplete, dropped: r.reconciliation?.dropped }));
    check('D5. the console prints the stop line and what did not run, never "Stability skipped"',
      d.messages.some((m) => m.startsWith(`Run stopped: ${REASON}. State saved.`)) && d.messages.includes('Stopped at the Stabilizer: nothing after it runs (no framework); 2 scenario(s) recorded as incomplete, never shipped unverified.') && !d.messages.some((m) => m.startsWith('Stability skipped')), JSON.stringify(d.messages.slice(-5)));
    const cp = loadCheckpoint(path.join(d.outDir, 'checkpoint.json'));
    check('D6. the checkpoint carries the verdicts the Critic paid for, so a resume replays and re-runs at $0', (cp.verdicts ?? []).length === 2 && cp.verdicts!.every((v) => v.verdict === 'pass'), JSON.stringify(cp.verdicts));
    check('D7. the empty-run diagnosis names the Stabilizer stop', diagnoseEmptyRun(r)?.cause === 'halted' && /^The run stopped at the Stabilizer/.test(diagnoseEmptyRun(r)?.lines[0] ?? ''), JSON.stringify(diagnoseEmptyRun(r)));
  }
} finally {
  process.chdir(agentCwd);
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a billing error stops the run at every stage that could have fallen back: the map (one call, no retry), the feature parser (never an empty list), the Critic (nothing replays unreviewed) and the Stabilizer (nothing ships unverified, nothing dropped as broken), each with the stop line, a balanced funnel and the checkpoint.');
