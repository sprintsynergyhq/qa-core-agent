import type { RunReport, Scenario } from './trace.js';
import { findHappyLoginScenario } from './auth-emit.js';
import { wrongPasswordSubmits } from './test-credentials.js';

/**
 * The emitted order of the sign-in tests (invariant 79, run 71d739 D2).
 *
 * Run 8's happy login met its bar line only because it happened to run
 * before the wrong-password executions; in the other order the same run
 * would have failed it, and every run of the shipped framework spends one
 * wrong-password submit against the account in .env. Both emitters now put
 * the happy login and every wrong-password test of the same spec in one
 * nested describe in serial mode, the happy login first: the wrong-password
 * test runs only after the account signed in, and a failed sign-in skips it,
 * so a suite run never adds a failed login to an account that does not sign
 * in. A report with no wrong-password test emits exactly as before.
 */

/** The nested describe's title. */
export const LOGIN_SEQUENCE_TITLE = 'sign-in order: the happy login runs first, then the wrong-password test';

/** The line that puts the nested describe in serial mode. */
export const SERIAL_MODE_LINE = `test.describe.configure({ mode: 'serial' });`;

/** The comment above the nested describe, one string per line. */
export const LOGIN_SEQUENCE_COMMENT = [
  '// The wrong-password test submits one failed login per suite run against the',
  '// account in .env. Serial mode runs it after the happy login, and only when the',
  '// happy login passed, so a suite run never adds a failed login to a locked account.',
];

/** The scenarios of one spec that run in the serial block, happy login first, or null when the spec has no wrong-password test. */
export interface LoginSequence {
  /** The block's members in emitted order: the happy login (when in this spec), then every wrong-password test. */
  members: Scenario[];
  /** The member the block is emitted in place of: the first member in the spec's own order. */
  anchor: Scenario;
}

/**
 * The serial block of a spec's scenarios: null when none submits a wrong
 * password (wrongPasswordSubmits), else the happy login (the report's own,
 * findHappyLoginScenario, when it is in this spec) followed by every
 * wrong-password scenario in spec order.
 */
export function loginSequence(scenarios: Scenario[], happy: Scenario | null): LoginSequence | null {
  const wrong = scenarios.filter((s) => wrongPasswordSubmits(s) > 0);
  if (wrong.length === 0) return null;
  const members = [...(happy && scenarios.includes(happy) ? [happy] : []), ...wrong];
  const anchor = scenarios.find((s) => members.includes(s))!;
  return { members, anchor };
}

/**
 * The report the POM emitter groups: a wrong-password scenario whose feature
 * differs from the happy login's is grouped with the happy login, so both
 * land in one spec (the login feature's, which runs without the saved
 * session). Returns the report unchanged when there is nothing to move.
 */
export function withWrongPasswordBesideLogin(report: RunReport): RunReport {
  const happy = findHappyLoginScenario(report);
  if (!happy) return report;
  const moves = report.scenarios.some((s) => s !== happy && wrongPasswordSubmits(s) > 0 && s.feature !== happy.feature);
  if (!moves) return report;
  return {
    ...report,
    scenarios: report.scenarios.map((s) => (s !== happy && wrongPasswordSubmits(s) > 0 && s.feature !== happy.feature ? { ...s, feature: happy.feature } : s)),
  };
}

/** The wrong-password scenarios a report ships (for the README). */
export function wrongPasswordScenarios(report: Pick<RunReport, 'scenarios'>): Scenario[] {
  return report.scenarios.filter((s) => wrongPasswordSubmits(s) > 0);
}
