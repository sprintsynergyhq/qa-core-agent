/**
 * Locks history pruning (invariant 80, run 71d739 D5b).
 *
 * Run 8 re-read every get_dom body on every later call: the context each
 * Explorer call re-read grew from 16,467 to 78,895 tokens (mean 51,028). Now,
 * when a scenario closes, the get_dom results and the long tool outputs of
 * its turns become one line each; the tool calls and the assistant text stay,
 * and the scenario in progress is never touched. The edit happens only at a
 * scenario boundary, and the first call after it reads the unchanged history
 * through an anchor breakpoint, so the prompt cache still serves the history
 * (invariant 53).
 *
 * The run: explore() with a fixture Explorer (a scripted client) over 8
 * planned scenarios on a local catalogue page, each scenario opening with
 * begin_scenario, navigate and get_dom in one turn, then a fill, a click, two
 * assertions and end_scenario, with a short narration per turn (run 8
 * averaged 84 characters of text per call). The fixture client keeps a cache
 * the way the API does: an entry per breakpoint, and a read finds the longest
 * cached prefix at most 20 blocks before a breakpoint.
 *   A. (i) the first call of scenario 8 is within 1.5 times the first call of
 *      scenario 2 on the full serialized request (system, tools and
 *      messages), and on messages alone each finished scenario adds the same
 *      residue, its calls and text, less than one get_dom body (both sizes
 *      are printed); (ii) no get_dom body of a
 *      finished scenario is in any later request; (iii) the current
 *      scenario's get_dom body is present in every later request of it.
 *   B. invariant 53: past the second call, cache read exceeds input plus
 *      cache creation on every call; the history prefix changes at most once
 *      per scenario, only on the first call after a scenario closed, and that
 *      call reads every block before the edit from cache (the anchor).
 *   C. the tool calls and the assistant text of a finished scenario stay.
 * $0: no model call, no network beyond 127.0.0.1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { explore, type ReviewPaused } from '../src/agent/runtime.js';
import { prunedResultLine } from '../src/agent/history-prune.js';
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

/* ─── the fixture catalogue: each scenario's page carries its own token ───── */
const N = 8;
const token = (i: number): string => `Token k7q${i}z`;
const pageHtml = (i: number): string => `<!doctype html><html lang="en"><head><title>Catalogue ${i}</title></head><body>
<header><a href="/">Home</a> <a href="/cart">Cart</a> <a href="/account">Account</a></header>
<main><h1>Catalogue</h1>
<label for="search">Search</label><input id="search" name="q" placeholder="Search products">
<button type="button" id="go">Search</button><p id="status" role="status"></p>
<button type="button">${token(i)}</button>
<ul>${Array.from({ length: 24 }, (_, k) => `<li><a href="/product/${k}">Product ${k} of page ${i}</a> <button type="button">Add product ${k} to cart</button></li>`).join('')}</ul>
</main>
<script>document.getElementById('go').addEventListener('click', () => { setTimeout(() => { document.getElementById('status').textContent = 'Search complete'; }, 200); });</script>
</body></html>`;
const server = http.createServer((req, res) => {
  const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '0');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pageHtml(n));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const names = Array.from({ length: N }, (_, i) => `searched the catalogue on page ${i + 1} and saw the search complete`);
const plan: PlannedScenario[] = names.map((name, i) => ({ name, category: 'happy', rationale: 'r', feature: 'catalogue', pageUrl: `${base}/catalogue?n=${i + 1}` }));

/* ─── the fixture Explorer and its cache ───────────────────────────────────── */
type Use = { name: string; input: Record<string, unknown> };
const say = (i: number, what: string): string => `Scenario ${i}: ${what}. Checking the page state before the next step.`;
const turns: Array<{ text: string; uses: Use[] }> = [];
for (let i = 1; i <= N; i++) {
  turns.push({ text: say(i, 'starting on its planned page'), uses: [
    { name: 'begin_scenario', input: { name: names[i - 1], category: 'happy', feature: 'catalogue' } },
    { name: 'navigate', input: { url: `${base}/catalogue?n=${i}` } },
    { name: 'get_dom', input: {} },
  ] });
  turns.push({ text: say(i, 'typing the search term'), uses: [{ name: 'fill', input: { css: '#search', value: 'pliers', intent: 'search box' } }] });
  turns.push({ text: say(i, 'running the search'), uses: [{ name: 'click', input: { css: '#go', intent: 'search button' } }] });
  turns.push({ text: say(i, 'the status line should show'), uses: [{ name: 'assert', input: { type: 'toBeVisible', css: '#status', intent: 'search status', timeout: 10000 } }] });
  // Scenario 1 also asserts a wrong status once: its Playwright error is a long tool output.
  if (i === 1) turns.push({ text: say(i, 'checking a status it should not show'), uses: [{ name: 'assert', input: { type: 'toContainText', css: '#status', text: 'Search failed', intent: 'search status message', timeout: 1000 } }] });
  turns.push({ text: say(i, 'the status should read complete'), uses: [{ name: 'assert', input: { type: 'toContainText', css: '#status', text: 'Search complete', intent: 'search status message', timeout: 10000 } }] });
  turns.push({ text: say(i, 'closing it'), uses: [{ name: 'end_scenario', input: {} }] });
}
turns.push({ text: 'All planned scenarios are recorded.', uses: [{ name: 'finish', input: { summary: 'eight searches' } }] });

interface Sent { messages: string; full: string; read: number; creation: number; input: number; headTokens: number; tokensThroughAnchor: number; edited: boolean }
const sent: Sent[] = [];
const cache = new Set<string>();
let prevBlocks: string[] = [];
const strip = (b: unknown): unknown => { const { cache_control: _c, ...rest } = b as Record<string, unknown>; return rest; };
const toks = (s: string): number => Math.ceil(s.length / 4);
let useId = 0;
let turnIx = 0;
const client = {
  messages: {
    create: async (params: { tools: unknown[]; system: Array<Record<string, unknown>>; messages: Anthropic.MessageParam[] }) => {
      const copy = JSON.parse(JSON.stringify({ messages: params.messages, system: params.system, tools: params.tools })) as typeof params;
      // Flatten the request into the cache's blocks: tools, system, then every message block.
      const blocks: Array<{ s: string; marked: boolean }> = [];
      for (const t of copy.tools) blocks.push({ s: JSON.stringify(t), marked: false });
      for (const b of copy.system) blocks.push({ s: JSON.stringify(strip(b)), marked: !!b.cache_control });
      const head = blocks.length;
      const msgOf: number[] = [];
      copy.messages.forEach((m, mi) => {
        const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        content.forEach((b, j) => { blocks.push({ s: `${mi}:${m.role}:${j}:${JSON.stringify(strip(b))}`, marked: !!(b as { cache_control?: unknown }).cache_control }); msgOf.push(mi); });
      });
      const hashes: string[] = [];
      let h = '';
      for (const b of blocks) { h = crypto.createHash('sha1').update(h + b.s).digest('hex'); hashes.push(h); }
      const tokAt = blocks.map((b) => toks(b.s));
      const sum = (from: number, to: number): number => tokAt.slice(from, to + 1).reduce((a, b) => a + b, 0);
      const marks = blocks.map((b, i) => (b.marked ? i : -1)).filter((i) => i >= 0);
      let hit = -1;
      for (const m of marks) for (let j = m; j >= Math.max(0, m - 20); j--) if (cache.has(hashes[j]!)) { hit = Math.max(hit, j); break; }
      const lastMark = marks.length ? Math.max(...marks) : -1;
      const read = hit >= 0 ? sum(0, hit) : 0;
      const creation = lastMark > hit ? sum(hit + 1, lastMark) : 0;
      const input = sum(lastMark + 1, blocks.length - 1);
      for (const m of marks) cache.add(hashes[m]!);
      // Did an earlier message block change (an edit, not an append)?
      const msgBlocks = blocks.slice(head).map((b) => b.s);
      const firstDiff = msgBlocks.findIndex((s, i) => i < prevBlocks.length && s !== prevBlocks[i]);
      const edited = firstDiff >= 0;
      // The most the cache can serve on an edit call: every block through the
      // message before the edited turn's assistant message (an earlier tail).
      let tokensThroughAnchor = 0;
      if (edited) {
        const anchorMsg = msgOf[firstDiff]! - 2;
        const lastBlock = msgOf.lastIndexOf(anchorMsg);
        tokensThroughAnchor = sum(0, head + lastBlock);
      }
      prevBlocks = msgBlocks;
      sent.push({ messages: JSON.stringify(params.messages), full: JSON.stringify({ system: params.system, tools: params.tools, messages: params.messages }), read, creation, input, headTokens: sum(0, head - 1), tokensThroughAnchor, edited });
      const usage = { input_tokens: input, output_tokens: 80, cache_read_input_tokens: read, cache_creation_input_tokens: creation };
      const t = turns[turnIx++];
      if (!t) return { usage, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      return { usage, stop_reason: 'tool_use', content: [{ type: 'text', text: t.text }, ...t.uses.map((u) => ({ type: 'tool_use', id: `tu${++useId}`, name: u.name, input: u.input }))] };
    },
  },
} as unknown as Anthropic;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-history-prune-'));
const agentCwd = process.cwd();
process.chdir(tmpRoot);
try {
  const r = await explore({
    url: `${base}/catalogue?n=1`, language: 'ts', outDir: path.join(tmpRoot, 'run'), fromPlan: plan,
    model: 'claude-opus-4-7', maxUsd: 50, skipCritic: true, skipReplay: true, skipStability: true, stabilize: false, loginPreflightDone: true,
    explorerClient: client,
  });
  if ((r as ReviewPaused).paused) throw new Error('unexpected pause');
  const report = r as RunReport;
  check('0. the fixture run recorded all 8 scenarios, every scripted turn consumed', report.scenarios.length === N && turnIx === turns.length, `${report.scenarios.length} scenarios, ${turnIx} of ${turns.length} turns`);

  // The first call of scenario i: the first request carrying its begin_scenario result.
  const firstCall = (i: number): number => sent.findIndex((x) => x.messages.includes(`"name":${JSON.stringify(names[i - 1])},"category"`) && x.messages.includes(token(i)));
  const rows = Array.from({ length: N }, (_, k) => { const ix = firstCall(k + 1); return { i: k + 1, ix, msgs: sent[ix]?.messages.length ?? -1, full: sent[ix]?.full.length ?? -1, ctx: sent[ix] ? sent[ix]!.read + sent[ix]!.creation + sent[ix]!.input : -1 }; });
  console.log('   scenario | call # | messages chars | full request chars | context tokens (read + write + input)');
  for (const row of rows) console.log(`   ${row.i} | ${row.ix + 1} | ${row.msgs} | ${row.full} | ${row.ctx}`);
  const s2 = rows[1]!;
  const s8 = rows[7]!;
  console.log(`   ratio scenario 8 / scenario 2: messages ${(s8.msgs / s2.msgs).toFixed(2)}, full request ${(s8.full / s2.full).toFixed(2)}, context tokens ${(s8.ctx / s2.ctx).toFixed(2)}`);
  // (i) on the full serialized request, what each call sends and re-reads (the
  // basis of run 8's per-call context numbers). On messages alone the ratio is
  // higher: a finished scenario keeps its tool calls and its text, by design.
  check('A1. (i) the first call of scenario 8 is within 1.5 times the first call of scenario 2 (the full serialized request: system, tools and messages)', s2.full > 0 && s8.full <= 1.5 * s2.full, `${s8.full} vs ${s2.full}`);
  const domBody = sent[s2.ix]!.messages.length - sent[s2.ix - 1]!.messages.length;
  const growth = rows.slice(1).map((row, k) => row.msgs - rows[k]!.msgs);
  // Scenario 1 has one extra turn (the failed assertion below); 2 to 7 run the same script.
  check('A1b. on messages alone, each finished scenario adds a small residue (its calls and text), less than one get_dom body, the same for identical scenarios', growth.every((g) => g < domBody) && growth.slice(1).every((g) => g === growth[1]), `growth per scenario ${growth.join(', ')}; the newest round with a get_dom body ${domBody}`);

  // (ii) and (iii): each scenario's token is in its own get_dom body only.
  const prunedIn = (msgs: string, i: number): boolean => msgs.includes(JSON.stringify(prunedResultLine('get_dom', names[i - 1]!)).slice(1, -1));
  const closedAt = (i: number): number => sent.findIndex((x, ix) => ix > firstCall(i) && prunedIn(x.messages, i));
  let leaked: string[] = [];
  let missing: string[] = [];
  for (let i = 1; i <= N; i++) {
    const open = firstCall(i);
    const close = closedAt(i);
    for (let ix = open; ix < (close < 0 ? sent.length : close); ix++) if (!sent[ix]!.messages.includes(token(i))) missing.push(`scenario ${i} call ${ix + 1}`);
    if (close >= 0) for (let ix = close; ix < sent.length; ix++) if (sent[ix]!.messages.includes(token(i))) leaked.push(`scenario ${i} call ${ix + 1}`);
    if (i < N && close < 0) leaked.push(`scenario ${i} never pruned`);
  }
  check('A2. (ii) no get_dom body of a finished scenario is in any later request', leaked.length === 0, leaked.slice(0, 6).join(', '));
  check('A3. (iii) the current scenario\'s get_dom body is present in every request of it until it closes', missing.length === 0, missing.slice(0, 6).join(', '));
  // A long tool output (scenario 1's failed assertion, Playwright's error with its call log) goes too.
  const longMark = 'Received string';
  const longOpen = sent.findIndex((x) => x.messages.includes(longMark));
  const close1 = closedAt(1);
  check('A4. a long tool output of a finished scenario (a failed assertion\'s error) is in its own requests, then pruned at the boundary',
    longOpen >= 0 && longOpen < close1 && sent.slice(close1).every((x) => !x.messages.includes(longMark)) && sent[close1]!.messages.includes(JSON.stringify(prunedResultLine('assert', names[0]!)).slice(1, -1)),
    `first seen at call ${longOpen + 1}, scenario 1 closed at call ${close1 + 1}`);

  /* ─── B. invariant 53 and the boundary ─────────────────────────────────── */
  const calls = report.cost.calls ?? [];
  const bad = calls.slice(2).map((c, k) => ({ c, k: k + 3 })).filter(({ c }) => !(c.cacheRead > c.input + c.cacheCreation));
  check('B1. invariant 53: past the second call, cache read exceeds input plus cache creation on every call', calls.length === sent.length && bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  const edits = sent.map((x, ix) => ({ x, ix })).filter(({ x }) => x.edited);
  check(`B2. the history prefix changed ${N} times, at most once per closed scenario`, edits.length === N, `${edits.length} edits at calls ${edits.map((e) => e.ix + 1).join(', ')}`);
  // The newest turn of an edit call is the end_scenario that closed a scenario.
  const newestTool = (ix: number): string | undefined => {
    const msgs = JSON.parse(sent[ix]!.messages) as Array<{ role: string; content: Array<{ type: string; name?: string }> }>;
    return msgs[msgs.length - 2]?.content.filter((b) => b.type === 'tool_use').at(-1)?.name;
  };
  check('B3. every edit is on the first call after a scenario closed (its end_scenario is the newest turn)', edits.every(({ ix }) => newestTool(ix) === 'end_scenario'), edits.map((e) => `${e.ix + 1}:${newestTool(e.ix)}`).join(', '));
  check('B4. each such call reads the whole history before the closed scenario from cache (the anchor breakpoint), never only the system prompt',
    edits.length > 0 && edits.every(({ x }) => x.read >= x.tokensThroughAnchor && x.tokensThroughAnchor > x.headTokens), JSON.stringify(edits.map(({ x, ix }) => ({ call: ix + 1, read: x.read, throughAnchor: x.tokensThroughAnchor, systemOnly: x.headTokens }))));

  /* ─── C. what stays ────────────────────────────────────────────────────── */
  const lastReq = sent[sent.length - 1]!.messages;
  check('C1. the tool calls of finished scenarios stay (every begin_scenario input is in the last request)', names.every((n) => lastReq.includes(`"name":${JSON.stringify(n)},"category"`)));
  check('C2. the assistant text of finished scenarios stays', lastReq.includes(say(1, 'starting on its planned page')) && lastReq.includes(say(N - 1, 'closing it')));
  check('C3. each finished scenario\'s get_dom result is exactly one line naming it', names.slice(0, N - 1).every((n) => lastReq.includes(JSON.stringify(prunedResultLine('get_dom', n)).slice(1, -1))));

  const ctxOf = (c: { input: number; cacheRead: number; cacheCreation: number }): number => c.input + c.cacheRead + c.cacheCreation;
  console.log(`   fixture context per call: first ${ctxOf(calls[0]!)}, last ${ctxOf(calls[calls.length - 1]!)}, mean ${Math.round(calls.reduce((a, c) => a + ctxOf(c), 0) / calls.length)} tokens over ${calls.length} calls`);
} finally {
  process.chdir(agentCwd);
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a finished scenario\'s get_dom bodies and long results leave the history at its boundary; the scenario in progress keeps its own; the cache still serves the history (invariant 53).');
