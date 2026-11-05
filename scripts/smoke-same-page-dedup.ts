/**
 * Locks same-page dedup (invariant 80, run 71d739 D8b).
 *
 * Run 8, events line 19: "Rejected cross-page duplicate: \"submitted the
 * login form with an empty password field and saw a required-field error\"
 * on http://localhost:4200/auth/login (same feature, category and rules R12,
 * names overlap 0.80 as the scenario kept on http://localhost:4200/auth/login)".
 * A different field's negative on the same page was lost, because
 * dedupeAcrossPages applied its overlap rule to the incoming page's own
 * scenarios. Now the overlap and evidence rules compare only scenarios
 * planned on another page.
 *   A. run 8's exact pair in one page's plan: both kept, no drop.
 *   B. the same pair, one from an earlier plan call on the same URL: both kept.
 *   C. the same pair on two pages: still merged by the overlap rule.
 *   D. the evidence rule: same rules on a page without page evidence merges
 *      across pages, never within one.
 *   E. an exact-name copy on the same page is still one scenario (the name
 *      rule is unchanged).
 * Pure; no browser, no model call.
 */
import { dedupeAcrossPages, nameOverlap, CROSS_PAGE_NAME_OVERLAP, type PlannedScenario } from '../src/agent/planner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const LOGIN = 'http://localhost:4200/auth/login';
const REGISTER = 'http://localhost:4200/auth/register';
const EMAIL = 'submitted the login form with an empty email field and saw a required-field error';
const PASSWORD = 'submitted the login form with an empty password field and saw a required-field error';
// The two scenarios exactly as run 8 planned them (plan[13] and the dropped copy).
const sc = (name: string, pageUrl: string): PlannedScenario => ({
  feature: 'account', category: 'negative', name,
  rationale: 'fails if the empty-field validation stops being enforced or the error stops rendering',
  ruleIds: ['R12'], pageUrl,
});
const tags = (url: string | undefined): string | undefined => (url ? 'account' : undefined);
const overlap = nameOverlap(EMAIL, PASSWORD);
console.log(`   run 8 pair: names overlap ${overlap.toFixed(2)} (the rule merges at ${CROSS_PAGE_NAME_OVERLAP})`);
check('0. the pair overlaps by 0.80, above the 0.75 merge threshold, with the same feature, category and rules', overlap.toFixed(2) === '0.80' && overlap >= CROSS_PAGE_NAME_OVERLAP);

/* ─── A. one page's plan ─────────────────────────────────────────────────── */
{
  const r = dedupeAcrossPages([], [sc(EMAIL, LOGIN), sc(PASSWORD, LOGIN)], { url: LOGIN, feature: 'account' }, tags);
  check('A1. run 8\'s pair planned on /auth/login in one call: both kept as two scenarios, nothing dropped',
    r.dropped.length === 0 && r.incoming.map((s) => s.name).join('|') === [EMAIL, PASSWORD].join('|'), JSON.stringify(r.dropped.map((d) => d.scenario.name)));
}

/* ─── B. an earlier call on the same URL ─────────────────────────────────── */
{
  const r = dedupeAcrossPages([sc(EMAIL, LOGIN)], [sc(PASSWORD, LOGIN)], { url: LOGIN, feature: 'account' }, tags);
  check('B1. the pair split across two plan calls on the same page: both kept', r.dropped.length === 0 && r.existing.length === 1 && r.incoming.length === 1, JSON.stringify(r.dropped));
  const slash = dedupeAcrossPages([sc(EMAIL, `${LOGIN}/`)], [sc(PASSWORD, `${LOGIN}?next=/account`)], { url: LOGIN, feature: 'account' }, tags);
  check('B2. the same page with a trailing slash or a query is still the same page: both kept', slash.dropped.length === 0);
}

/* ─── C. two pages ───────────────────────────────────────────────────────── */
{
  const r = dedupeAcrossPages([sc(EMAIL, LOGIN)], [sc(PASSWORD, REGISTER)], { url: REGISTER, feature: 'account' }, tags);
  check('C1. the same pair on two pages is still merged (overlap 0.80, same feature, category and rules)',
    r.dropped.length === 1 && r.dropped[0]!.basis.kind === 'overlap' && r.existing.length + r.incoming.length === 1, JSON.stringify(r.dropped.map((d) => ({ name: d.scenario.name, basis: d.basis }))));
}

/* ─── D. the evidence rule ───────────────────────────────────────────────── */
{
  // Same rules, low overlap, a page that does not carry the feature by evidence.
  const a: PlannedScenario = { ...sc('submitted the login form with an empty email field and saw a required-field error', LOGIN) };
  const b: PlannedScenario = { ...sc('left every field blank and pressed sign in', LOGIN) };
  const noEvidence = (): boolean => false;
  check('D0. the evidence pair overlaps below the threshold', nameOverlap(a.name, b.name) < CROSS_PAGE_NAME_OVERLAP);
  const same = dedupeAcrossPages([a], [b], { url: LOGIN, feature: 'account' }, tags, noEvidence);
  check('D1. on the same page the evidence rule never merges', same.dropped.length === 0, JSON.stringify(same.dropped));
  const other = dedupeAcrossPages([a], [{ ...b, pageUrl: REGISTER }], { url: REGISTER, feature: 'account' }, tags, noEvidence);
  check('D2. across pages it still drops the copy on the page without evidence', other.dropped.length === 1 && other.dropped[0]!.basis.kind === 'evidence', JSON.stringify(other.dropped));
}

/* ─── E. the name rule ───────────────────────────────────────────────────── */
{
  const r = dedupeAcrossPages([], [sc(EMAIL, LOGIN), sc(EMAIL, LOGIN)], { url: LOGIN, feature: 'account' }, tags);
  check('E1. an exact-name copy on the same page is still one scenario', r.dropped.length === 1 && r.dropped[0]!.basis.kind === 'name' && r.incoming.length === 1);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: run 8\'s login pair on one page is kept as two scenarios; the same pair on two pages is still merged; the overlap and evidence rules compare other pages only.');
