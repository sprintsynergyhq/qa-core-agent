/**
 * An absent counter reads "0" (invariant 80, run 71d739 D5a).
 *
 * On Toolshop's product page with a clean cart the cart badge does not exist
 * before the first add: a count capture is refused by RULE 9 (a badge is read
 * by its text), and a text capture could not resolve, so "capture the badge
 * text, add, assert_compare greater" could never be recorded and R6 dropped
 * on a fix the page cannot give. Now a text capture, or a compare re-read, on
 * a counter target (the targets RULE 9 names: isCounterSelector, read off the
 * locator only) that matches no element reads "0", and the step records
 * `absentAsZero: true`. Any other target that matches no element fails
 * loudly, as before.
 *
 * One source, the same rule in all four places (invariant 57): the body below
 * is JavaScript that is also valid TypeScript. The agent's reader (the tool
 * and replay) is built from it, and the framework's copy (helpers/
 * absent-counter in the POM output, inlined in the single-file spec) is the
 * same text, so the agent and the shipped test cannot drift.
 */
import type { Locator } from 'playwright';

/**
 * How long a capture waits for an absent counter to render before it reads
 * "0". A capture after an earlier action in the same scenario (the first add
 * clicked, the badge about to render) must not read too early; a clean cart
 * pays this once per capture. A compare re-read passes 0: it is polled.
 */
export const ABSENT_COUNTER_GRACE_MS = 2000;

const BODY_LINES: readonly string[] = [
  'const deadline = Date.now() + graceMs;',
  'while ((await locator.count()) === 0) {',
  `  if (Date.now() >= deadline) return '0';`,
  '  await new Promise((resolve) => setTimeout(resolve, 100));',
  '}',
  `return ((await locator.textContent({ timeout: 1000 })) ?? '').trim();`,
];

const DOC_LINES: readonly string[] = [
  'Read a counter (a cart badge, a quantity) by its text. A counter that is not',
  'on the page reads "0": a cart badge does not exist before the first add.',
  'Waits up to graceMs for it to render first; a compare re-read passes 0,',
  'because the compare polls. The agent recorded and replayed with the same logic.',
];

type Reader = (locator: Locator, graceMs: number) => Promise<string>;

// Built from the body above: the agent runs the exact text the framework ships.
const AsyncFunction = Object.getPrototypeOf(async function () { /* constructor only */ }).constructor as new (...args: string[]) => Reader;
const readImpl = new AsyncFunction('locator', 'graceMs', BODY_LINES.join('\n'));

/** The counter's trimmed text, or "0" when no element matches after graceMs. */
export async function readCounterText(locator: Locator, graceMs: number): Promise<string> {
  return String(await readImpl(locator, graceMs));
}

/** The helper the POM framework ships at helpers/absent-counter.{ts,js}, written only when a spec uses it. */
export function renderAbsentCounterHelper(lang: 'ts' | 'js'): string {
  const body = BODY_LINES.map((l) => `  ${l}`);
  if (lang === 'js') {
    return [
      '// @ts-check',
      '/**',
      ...DOC_LINES.map((l) => ` * ${l}`),
      " * @param {import('@playwright/test').Locator} locator",
      ' * @param {number} graceMs',
      ' * @returns {Promise<string>}',
      ' */',
      'async function readCounterText(locator, graceMs) {',
      ...body,
      '}',
      '',
      'module.exports = { readCounterText };',
      '',
    ].join('\n');
  }
  return [
    `import type { Locator } from '@playwright/test';`,
    '',
    '/**',
    ...DOC_LINES.map((l) => ` * ${l}`),
    ' */',
    'export async function readCounterText(locator: Locator, graceMs: number): Promise<string> {',
    ...body,
    '}',
    '',
  ].join('\n');
}

/** The same helper inlined into the single-file spec (transcriber.ts). */
export function inlineReadCounterTextFn(): string {
  return [
    ...DOC_LINES.map((l) => `// ${l}`),
    'async function readCounterText(locator, graceMs) {',
    ...BODY_LINES.map((l) => `  ${l}`),
    '}',
  ].join('\n');
}

/** The emitted read of an absentAsZero step: the capture waits the grace, a compare re-read does not. */
export function absentCounterReadExpr(locFirstExpr: string, kind: 'capture' | 'compare'): string {
  return `await readCounterText(${locFirstExpr}, ${kind === 'capture' ? ABSENT_COUNTER_GRACE_MS : 0})`;
}

/** True when a step list reads an absent counter (the emitters import or inline the helper only then). */
export function usesAbsentCounter(steps: ReadonlyArray<{ kind: string; absentAsZero?: true }>): boolean {
  return steps.some((s) => (s.kind === 'capture' || s.kind === 'assert_compare') && s.absentAsZero === true);
}
