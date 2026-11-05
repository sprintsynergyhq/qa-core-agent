/**
 * The kind of a finding: what the Explorer could not make happen.
 *
 *   product  the assertion retry cap tripped (invariant 13): the page was
 *            reached, the element was found, and the outcome the scenario
 *            expected never occurred. Product behavior for a person to review.
 *   locator  the selector recovery cap tripped (invariant 24): the element the
 *            scenario needed could not be resolved or recovered. A limit of the
 *            run, never product behavior, and never counted in "To review".
 *
 * Both kinds sit in the reconciliation `findings` bucket, so the identity
 * planned === generated + dropped + incomplete + findings + skipped +
 * emitted_failed is unchanged. The kind is written at the source (tools.ts,
 * required on every new finding) and derived for reports written before it
 * existed by `findingKindOf` below.
 */

export type FindingKind = 'product' | 'locator';

/**
 * The text the locator site in tools.ts writes. Both strings are engine
 * constants: the Explorer never passes them, no model writes them, so a
 * reader that recognises them reads engine output, never model text
 * (standing rule 1 holds).
 */
export const LOCATOR_EXPECTED_PREFIX = 'locate element: ';
export const LOCATOR_MESSAGE_PREFIX = 'Selector could not be resolved or recovered';

/** One finding as the Explorer records it and the run report carries it. */
export interface Finding {
  scenario: string;
  category?: string;
  expected: string;
  url: string;
  messages: string[];
  kind: FindingKind;
  /**
   * What the failing check itself reported the last time it ran: the
   * Expected and Received lines of the Playwright error, or the compare's
   * "captured X, now Y" (engine text, never model text; invariant 80).
   * Absent on a report written before the field and on a locator finding.
   */
  failure?: string;
}

/**
 * The part of a failing check's error a finding keeps: the Expected and
 * Received lines when Playwright printed them, else the first line, cut at
 * 200 characters. Never invents text: an empty error gives undefined.
 */
export function failureSummary(message: string): string | undefined {
  const plain = message.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  const pair = lines.filter((l) => /^(Expected|Received)\b/.test(l));
  const out = pair.length > 0 ? pair.join('; ') : lines[0];
  if (!out) return undefined;
  return out.length > 200 ? `${out.slice(0, 199)}…` : out;
}

/**
 * The kind of a finding, on any report. A finding written with a kind keeps
 * it. A finding from a report written before the field existed is a locator
 * finding only when its `expected` starts with LOCATOR_EXPECTED_PREFIX AND at
 * least one message starts with LOCATOR_MESSAGE_PREFIX, the two engine
 * constants the locator site has always written together; anything else is
 * product behavior. Every reader of a finding's kind goes through here.
 */
export function findingKindOf(finding: { kind?: FindingKind; expected: string; messages?: string[] }): FindingKind {
  if (finding.kind === 'product' || finding.kind === 'locator') return finding.kind;
  const expected = typeof finding.expected === 'string' && finding.expected.startsWith(LOCATOR_EXPECTED_PREFIX);
  const message = Array.isArray(finding.messages) && finding.messages.some((m) => typeof m === 'string' && m.startsWith(LOCATOR_MESSAGE_PREFIX));
  return expected && message ? 'locator' : 'product';
}

/** The element a locator finding looked for: its `expected` without the prefix. */
export function elementLookedFor(expected: string): string {
  return expected.startsWith(LOCATOR_EXPECTED_PREFIX) ? expected.slice(LOCATOR_EXPECTED_PREFIX.length) : expected;
}
