/**
 * The Explorer's history stops carrying a finished scenario's bulky tool
 * results (invariant 80, run 71d739 D5b).
 *
 * Run 8 re-read every get_dom body on every later call: 16 get_dom results,
 * 67,952 characters, stayed in the history, and the context each call
 * re-read grew from 16,467 to 78,895 tokens (mean 51,028), so the Explorer
 * cost per recorded scenario doubled against run 7. Now, when a scenario
 * closes (end_scenario accepted, skip_scenario, or a finding or a gate
 * strike that records it), every get_dom result of that scenario's turns and
 * every other tool result longer than PRUNE_RESULT_MIN_CHARS is replaced by
 * one line. The tool calls themselves and the assistant text stay, and
 * nothing of the scenario in progress is touched.
 *
 * Pruning edits history the prompt cache already holds, so it happens only
 * at a scenario boundary: the cached prefix changes at most once per
 * scenario. The first call after a prune reads the unchanged history through
 * an anchor breakpoint on the last block before the earliest changed turn
 * (that block was the tail of an earlier call, so its prefix is a cache
 * entry); without it the API's 20-block lookback from the tail would miss
 * every entry of a long scenario and write the whole history again
 * (invariant 53, placeCacheBreakpoints).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { scenarioNameKey } from './rule-coverage.js';

/** A finished scenario's tool results longer than this become one line; a get_dom result always does. */
export const PRUNE_RESULT_MIN_CHARS = 400;

/** The line a pruned tool result becomes. */
export function prunedResultLine(tool: string, scenario: string): string {
  return `[${tool} result of finished scenario "${scenario}" removed]`;
}

/** One scenario's tool calls, by tool_use id, while it runs and until it is pruned. */
export interface TrackedScenario {
  name: string;
  tools: Map<string, string>;
}

/** The tracker runAgentLoop keeps: the scenario in progress, and the closed ones not yet pruned. */
export interface HistoryTracker {
  tracked: TrackedScenario | null;
  ready: TrackedScenario[];
}

export function newHistoryTracker(): HistoryTracker {
  return { tracked: null, ready: [] };
}

/** What a scenario's closure is read from: the tool context's records. */
export interface ClosedView {
  current: { name: string } | null;
  scenarios: Array<{ name: string }>;
  skipped: Array<{ scenario: string }>;
  findings: Array<{ scenario: string }>;
  brokenByGate: Array<{ scenario: string }>;
}

/**
 * True when the scenario has a terminal record: accepted (scenarios),
 * skipped, a finding, or gate-broken. A gate rejection the model will retry
 * leaves no record, so its turns stay until the retry closes.
 */
export function scenarioClosed(ctx: ClosedView, name: string): boolean {
  const key = scenarioNameKey(name);
  return ctx.scenarios.some((s) => scenarioNameKey(s.name) === key)
    || ctx.skipped.some((s) => scenarioNameKey(s.scenario) === key)
    || ctx.findings.some((f) => scenarioNameKey(f.scenario) === key)
    || ctx.brokenByGate.some((b) => scenarioNameKey(b.scenario) === key);
}

/**
 * Record one executed tool call. `before` is the scenario in progress when
 * the call ran (null outside any scenario: such a call is never pruned). A
 * begin_scenario under the same name continues the tracked list (a restart
 * after a gate rejection); under another name it closes the previous list.
 */
export function trackToolCall(t: HistoryTracker, call: { id: string; name: string; ok: boolean }, before: string | null, ctx: ClosedView): void {
  if (call.name === 'begin_scenario' && call.ok && ctx.current) {
    if (t.tracked && scenarioNameKey(t.tracked.name) !== scenarioNameKey(ctx.current.name)) {
      t.ready.push(t.tracked);
      t.tracked = null;
    }
    t.tracked ??= { name: ctx.current.name, tools: new Map() };
    t.tracked.name = ctx.current.name;
    t.tracked.tools.set(call.id, call.name);
    return;
  }
  if (!t.tracked || before === null) return;
  t.tracked.tools.set(call.id, call.name);
  if (!ctx.current && scenarioClosed(ctx, t.tracked.name)) {
    t.ready.push(t.tracked);
    t.tracked = null;
  }
}

function contentLength(content: Anthropic.ToolResultBlockParam['content']): number {
  if (typeof content === 'string') return content.length;
  return JSON.stringify(content ?? '').length;
}

/**
 * Replace the bulky tool results of the closed scenarios in `messages` (in
 * place) and return how many were replaced and the anchor block: the last
 * block of the message before the assistant turn of the earliest replaced
 * result. Null anchor when nothing was replaced.
 */
export function pruneFinishedScenarios(messages: Anthropic.MessageParam[], ready: TrackedScenario[]): { pruned: number; anchor: object | null } {
  const owner = new Map<string, { tool: string; scenario: string }>();
  for (const r of ready) for (const [id, tool] of r.tools) owner.set(id, { tool, scenario: r.name });
  let pruned = 0;
  let earliest = -1;
  messages.forEach((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const who = owner.get(b.tool_use_id);
      if (!who) continue;
      if (who.tool !== 'get_dom' && contentLength(b.content) <= PRUNE_RESULT_MIN_CHARS) continue;
      const line = prunedResultLine(who.tool, who.scenario);
      if (b.content === line) continue;
      b.content = line;
      pruned++;
      if (earliest < 0) earliest = i;
    }
  });
  if (earliest < 0) return { pruned, anchor: null };
  // The result sits in messages[earliest]; its tool_use in messages[earliest - 1];
  // the message before that was the tail of the call that produced the tool_use.
  const before = messages[earliest - 2];
  if (!before) return { pruned, anchor: null };
  if (typeof before.content === 'string') before.content = [{ type: 'text', text: before.content }];
  const anchor = before.content[before.content.length - 1] ?? null;
  return { pruned, anchor };
}
