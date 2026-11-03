/**
 * Locks the page relevance filter (src/agent/page-filter.ts):
 *   - passthrough when the set is already under the cap
 *   - the caps: 8 pages with a feature list, 5 without
 *   - the deterministic fallback: first N shallowest unique-pathname pages,
 *     stable on ties, used when no API key is available
 *   - parsePickResponse validates the model's pick against the input list
 *     (URL or pathname match, cap enforced, dedupe, feature tags carried)
 *
 *   - K (run 71d739 D7, invariant 79): every fallback names its reason, and
 *     a billing error from the model client (run 8 attempt 1's, verbatim) is
 *     never a fallback: filterPages throws it, and through explore() the run
 *     stops with the billing stop line and a checkpoint, with no
 *     "(deterministic fallback)" line at all
 *
 * Pure in-code fixtures and a fake model client; section K serves a local
 * fixture site for explore(). No request leaves the machine.
 */
import {
  fallbackFilter,
  filterPages,
  pageCapFor,
  parsePickResponse,
  FILTERED_SOURCES,
  MAX_PAGES_WITH_FEATURES,
  MAX_PAGES_NO_FEATURES,
} from '../src/agent/page-filter.js';
import { capVolatile, plainFeatureMatches, FEATURE_PATH_TOKENS, tokensFor, groupByTemplate, pathTemplate, segmentFeature } from '../src/agent/page-filter.js';
import { writeDiscoveryJson, discoverPages, CRAWL_VOLATILE_CAP, CRAWL_PAGE_CAP } from '../src/agent/discovery.js';
import { featureTokenMap, ruleContentTokens, type RequirementsMap } from '../src/agent/requirements.js';
import os from 'node:os';
import path from 'node:path';
import { isVolatilePath, type DiscoveredPage } from '../src/agent/discovery.js';
import { VOLATILE_PAGE_GUIDANCE } from '../src/agent/planner.js';
import http from 'node:http';
import { explore } from '../src/agent/runtime.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const page = (url: string): DiscoveredPage => ({ url, source: 'sitemap' });

/* ─── A. caps ──────────────────────────────────────────────────────────────── */
check('A1. cap is 8 with a feature list', pageCapFor(['login', 'cart']) === MAX_PAGES_WITH_FEATURES && MAX_PAGES_WITH_FEATURES === 8);
check('A2. cap is 5 without one', pageCapFor(undefined) === MAX_PAGES_NO_FEATURES && MAX_PAGES_NO_FEATURES === 5);
check('A3. an empty feature list counts as none', pageCapFor([]) === MAX_PAGES_NO_FEATURES);

/* ─── B. deterministic fallback ────────────────────────────────────────────── */
const many = [
  page('https://s.example/a/b/c/deep1'),
  page('https://s.example/login'),
  page('https://s.example/'),
  page('https://s.example/a/b/mid1'),
  page('https://s.example/cart'),
  page('https://s.example/login'), // duplicate pathname
  page('https://s.example/x/y/mid2'),
  page('https://s.example/contact'),
  page('https://s.example/p/q/r/deep2'),
  page('https://s.example/search'),
];
const fb = fallbackFilter(many, 5);
check('B1. fallback keeps the cap', fb.length === 5, String(fb.length));
check('B2. shallowest pages win', JSON.stringify(fb.map((p) => new URL(p.url).pathname)) === JSON.stringify(['/', '/login', '/cart', '/contact', '/search']), JSON.stringify(fb.map((p) => p.url)));
check('B3. duplicate pathname removed', fb.filter((p) => p.url.endsWith('/login')).length === 1);
const tie = fallbackFilter([page('https://s.example/b'), page('https://s.example/a')], 2);
check('B4. ties keep discovery order (stable)', tie[0]?.url.endsWith('/b') === true && tie[1]?.url.endsWith('/a') === true);

/* ─── C. filterPages: passthrough and no-key fallback ──────────────────────── */
{
  const few = [page('https://s.example/login'), page('https://s.example/cart')];
  const r = await filterPages({ pages: few, features: ['login'], apiKey: undefined });
  check('C1. a set under the cap passes through untouched', r.method === 'passthrough' && JSON.stringify(r.pages) === JSON.stringify(few) && r.costUsd === 0);
}
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await filterPages({ pages: many, features: undefined });
    check('C2. over the cap with no API key uses the deterministic fallback', r.method === 'fallback' && r.pages.length === 5);
    check('C3. fallback result equals fallbackFilter output', JSON.stringify(r.pages) === JSON.stringify(fallbackFilter(many, 5)));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

/* ─── D. parsePickResponse validation ──────────────────────────────────────── */
const pool = [
  page('https://s.example/login'),
  page('https://s.example/cart'),
  page('https://s.example/search'),
  page('https://s.example/contact'),
];
{
  const picked = parsePickResponse(
    `[{"url":"https://s.example/login","feature":"login"},{"url":"https://s.example/cart","feature":"cart"}]`,
    pool, 8,
  );
  check('D1. a clean pick parses with feature tags carried', picked.length === 2 && picked[0]?.feature === 'login' && picked[1]?.feature === 'cart');
}
{
  const picked = parsePickResponse(
    `Here you go:\n[{"url":"https://s.example/search"},{"url":"https://s.example/invented"},{"url":"https://s.example/search"}]`,
    pool, 8,
  );
  check('D2. invented URLs are rejected and duplicates deduped', picked.length === 1 && picked[0]?.url.endsWith('/search') === true, JSON.stringify(picked));
}
{
  const picked = parsePickResponse(`[{"url":"/cart","feature":"cart"}]`, pool, 8);
  check('D3. a pathname-only echo matches the input page', picked.length === 1 && picked[0]?.url === 'https://s.example/cart');
}
{
  const picked = parsePickResponse(
    `[${pool.map((p) => `{"url":"${p.url}"}`).join(',')}]`,
    pool, 2,
  );
  check('D4. the cap is enforced on the pick', picked.length === 2);
}
check('D5. garbage returns [] (caller falls back)', parsePickResponse('no json here', pool, 8).length === 0);
check('D6. malformed JSON returns [] without throwing', parsePickResponse('[{"url": broken]', pool, 8).length === 0);

/* ─── E. which discovery sources go through the filter ─────────────────────── */
check('E1. sitemap and both crawls are filtered',
  FILTERED_SOURCES.has('sitemap') && FILTERED_SOURCES.has('crawl') && FILTERED_SOURCES.has('browser-crawl'));
check('E2. SRS and user page sets are never trimmed', !FILTERED_SOURCES.has('srs') && !FILTERED_SOURCES.has('user') && !FILTERED_SOURCES.has('entry'));
{
  const browserPages = many.map((p) => ({ ...p, source: 'browser-crawl' as const }));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await filterPages({ pages: browserPages, features: undefined });
    check('E3. a browser-crawl set over the cap is trimmed like any remote set',
      r.pages.length === 5 && r.pages.every((p) => p.source === 'browser-crawl'));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

/* ─── F. volatile-page detection and preference ────────────────────────────── */
check('F1. a uuid segment is volatile', isVolatilePath('/product/3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c'));
check('F2. a 24-char hex id is volatile', isVolatilePath('/product/507f1f77bcf86cd799439011'));
check('F3. a 26-char ulid-style id is volatile', isVolatilePath('/product/01jx8f2k9d3m7q5w8r2t4y6z'));
check('F4. stable paths are not volatile',
  !isVolatilePath('/login') && !isVolatilePath('/contact') && !isVolatilePath('/product-category/rakes') && !isVolatilePath('/checkout/payment'));
check('F5. a long pure-alpha segment is not volatile (words are not ids)', !isVolatilePath('/internationalization'));

const vol = (id: string): DiscoveredPage => ({ url: `https://s.example/product/${id}`, source: 'browser-crawl', volatile: true });
const stable = (p: string): DiscoveredPage => ({ url: `https://s.example${p}`, source: 'browser-crawl' });
{
  // A volatile detail page listed FIRST must still lose to stable pages.
  const mixed = [vol('01jx8f2k9d3m7q5w8r2t4y6z'), stable('/login'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/contact'), vol('01jx8f2k9d3m7q5w8r2t4y8b'), stable('/category/rakes')];
  const picked = fallbackFilter(mixed, 4);
  check('F6. the fallback prefers stable-path pages over volatile detail pages',
    picked.slice(0, 3).every((p) => !p.volatile), JSON.stringify(picked.map((p) => p.url)));
  check('F7. at most ONE volatile page survives the filter',
    picked.filter((p) => p.volatile).length === 1, JSON.stringify(picked.map((p) => p.url)));
}
check('F8. capVolatile keeps the first volatile page and every stable one',
  JSON.stringify(capVolatile([stable('/a'), vol('01jx8f2k9d3m7q5w8r2t4y6z'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/b')]).map((p) => new URL(p.url).pathname))
    === JSON.stringify(['/a', '/product/01jx8f2k9d3m7q5w8r2t4y6z', '/b']));
{
  // Passthrough (under the cap) still applies the one-volatile rule.
  const r = await filterPages({ pages: [vol('01jx8f2k9d3m7q5w8r2t4y6z'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/login')], features: undefined, apiKey: undefined });
  check('F9. passthrough sets keep at most one volatile page', r.pages.filter((p) => p.volatile).length === 1 && r.pages.length === 2);
}

/* ─── G. the durable-navigation prompt text exists (presence, not behavior) ── */
check('G1. the LLM filter guidance prefers stable paths and caps volatile picks',
  /STABLE-PATH pages/.test(fs.readFileSync('src/agent/page-filter.ts', 'utf8')) &&
  /at most ONE such volatile detail page/.test(fs.readFileSync('src/agent/page-filter.ts', 'utf8')));
check('G2. the Planner volatile-page guidance instructs the durable path',
  /DURABLE INTERACTION/.test(VOLATILE_PAGE_GUIDANCE) && /VISIBLE NAME/.test(VOLATILE_PAGE_GUIDANCE) && /Never plan a scenario that hardcodes this URL/.test(VOLATILE_PAGE_GUIDANCE));
check('G3. the Explorer doctrine bans direct generated-id navigation (checked on the rendered prompt; the doctrine text lives in doctrine.ts)',
  /Never navigate directly to a URL that carries a generated id/.test(EXPLORER_SYSTEM_PROMPT));
check('G4. the plan text marks volatile pages for the Explorer',
  /VOLATILE generated-id URL/.test(fs.readFileSync('src/agent/runtime.ts', 'utf8')));

/* ─── H. plain feature matches survive the filter; discovery.json lists the candidates ── */
// Run ec8eff: the crawl found /auth/register, the SRS had a registration
// feature, and the pick dropped it. A path that plainly names a feature is
// kept before any pick.
const nine = ['/', '/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'].map((pth): DiscoveredPage => ({ url: `https://s.example${pth}`, source: 'browser-crawl' }));
const deep: DiscoveredPage[] = [{ url: 'https://s.example/auth/register', source: 'browser-crawl' }, { url: 'https://s.example/shop/checkout', source: 'browser-crawl' }];
const plain = plainFeatureMatches([...nine, ...deep], ['registration', 'cart', 'contact']);
check('H1. /auth/register plainly matches registration and /shop/checkout matches cart, each tagged with the feature', plain.length === 2 && plain.find((p) => p.url.endsWith('/auth/register'))?.feature === 'registration' && plain.find((p) => p.url.endsWith('/shop/checkout'))?.feature === 'cart', JSON.stringify(plain));
check('H2. the token table covers product, cart, contact, login and register', ['product', 'cart', 'contact', 'login', 'register'].every((f) => Array.isArray(FEATURE_PATH_TOKENS[f]) && FEATURE_PATH_TOKENS[f]!.length > 0));
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await filterPages({ pages: [...nine, ...deep], features: ['registration', 'cart', 'contact'] });
    check('H3. over the cap, the deterministic filter keeps both plain matches although the shallow trim alone would drop them', r.method === 'fallback' && r.pages.length === 8 && r.pages.some((p) => p.url.endsWith('/auth/register')) && r.pages.some((p) => p.url.endsWith('/shop/checkout')), JSON.stringify(r.pages.map((p) => p.url)));
    check('H4. the kept pages carry their feature so per-page planning gets the feature\'s rules', r.pages.find((p) => p.url.endsWith('/auth/register'))?.feature === 'registration');
    check('H5. the rest of the cap is filled shallowest-first from the other candidates', r.pages.filter((p) => !p.feature).length === 6 && r.pages.some((p) => p.url === 'https://s.example/'));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-disc-'));
  const file = writeDiscoveryJson(dir, { method: 'browser-crawl', candidates: [...nine, ...deep], pages: deep, warnings: ['sitemap: none'] });
  const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { method: string; candidates: unknown[]; pages: unknown[]; warnings: string[] };
  check('H6. discovery.json lists every candidate, the pages kept, the method and the warnings', path.basename(file) === 'discovery.json' && written.candidates.length === 11 && written.pages.length === 2 && written.method === 'browser-crawl' && written.warnings[0] === 'sitemap: none', JSON.stringify(written).slice(0, 200));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── I. the f3b41e URLs are tagged by what they are ───────────────────────── */
{
  const f3b41e = ['/', '/category/hand-tools', '/category/power-tools', '/category/other', '/category/special-tools', '/rentals', '/contact', '/auth/login', '/privacy', '/auth/register', '/auth/forgot-password']
    .map((pth): DiscoveredPage => ({ url: `https://practicesoftwaretesting.com${pth}`, source: 'browser-crawl' }));
  const mapFeatures = ['product-listing', 'product-search', 'category-filter', 'price-sorting', 'product-detail', 'add-to-cart', 'cart-display', 'update-cart-quantity', 'remove-from-cart', 'login', 'user-registration', 'contact-form'];
  const tagged = plainFeatureMatches(f3b41e, mapFeatures);
  const tag = (pth: string) => tagged.find((p) => p.url.endsWith(pth))?.feature ?? null;
  check('I1. /auth/login is login and /auth/register is user-registration; "auth" alone tags nothing', tag('/auth/login') === 'login' && tag('/auth/register') === 'user-registration', JSON.stringify(tagged.map((p) => [p.url, p.feature])));
  check('I2. /auth/forgot-password is no longer tagged login (no recovery feature in this map, so it is left to the pick)', tag('/auth/forgot-password') === null);
  check('I3. /contact is tagged contact-form through the word match', tag('/contact') === 'contact-form');
  check('I4. the login token set has no "auth"; registration and password-recovery sets exist', !FEATURE_PATH_TOKENS['login']!.includes('auth') && FEATURE_PATH_TOKENS['registration']!.includes('create-account') && FEATURE_PATH_TOKENS['password-recovery']!.includes('forgot') && FEATURE_PATH_TOKENS['password-recovery']!.includes('reset') && FEATURE_PATH_TOKENS['password-recovery']!.includes('recover'));
  check('I5. a map with a password-recovery feature tags /auth/forgot-password with it', plainFeatureMatches(f3b41e, ['login', 'password-recovery']).find((p) => p.url.endsWith('/auth/forgot-password'))?.feature === 'password-recovery');
  check('I6. tokensFor resolves a compound feature name by its words', JSON.stringify(tokensFor('user-registration')) === JSON.stringify(FEATURE_PATH_TOKENS['registration']) && tokensFor('contact-form').includes('contact') && JSON.stringify(tokensFor('warranty')) === JSON.stringify(['warranty']));
}

/* ─── J. one plan per path template; volatile pages never fill the crawl cap; rule content names the feature ── */
{
  const ORIGIN = 'https://practicesoftwaretesting.com';
  const bc = (path: string, anchorPolls?: number[]): DiscoveredPage => ({ url: `${ORIGIN}${path}`, source: 'browser-crawl', ...(anchorPolls ? { anchorPolls } : {}) });
  // The 5e4394 candidate set: four /category/* siblings (power-tools first
  // and nav-only, hand-tools second with rendered products), plus the pages
  // that must stay apart. /auth/login and /auth/register share /auth but
  // name different features, so they are two templates, not one.
  const set = [
    bc('/'),
    bc('/category/power-tools', [17, 17, 17, 17]),
    bc('/category/hand-tools', [17, 17, 26, 26]),
    bc('/category/other', [17, 17, 26, 26]),
    bc('/category/special-tools', [17, 17, 17, 17]),
    bc('/rentals', [16, 16]),
    bc('/contact', [16, 16]),
    bc('/auth/login', [18, 18]),
    bc('/auth/register', [18, 18]),
    { ...bc('/product/01M2TKYPB9C93P8WTG7P7B2307'), volatile: true },
  ];
  check('J1. pathTemplate splits a two-segment path into prefix and last segment, and a one-segment path has no template',
    JSON.stringify(pathTemplate(`${ORIGIN}/category/hand-tools`)) === JSON.stringify({ prefix: '/category', last: 'hand-tools' }) && pathTemplate(`${ORIGIN}/rentals`) === null);
  check('J2. segmentFeature names login and registration from the token table and nothing for a category slug',
    segmentFeature('login') === 'login' && segmentFeature('register') === 'registration' && segmentFeature('hand-tools') === null);
  const g = groupByTemplate(set);
  const planned = g.pages.map((p) => new URL(p.url).pathname);
  check('J3. four /category/* pages yield ONE plan: the first sibling with rendered content is the representative',
    planned.filter((p) => p.startsWith('/category/')).length === 1 && planned.includes('/category/hand-tools'), JSON.stringify(planned));
  check('J4. the other three siblings are recorded as same template as the representative, never planned',
    g.sameTemplate.length === 3 && g.sameTemplate.every((p) => p.sameTemplateAs === `${ORIGIN}/category/hand-tools`) && g.sameTemplate.map((p) => new URL(p.url).pathname).sort().join(',') === '/category/other,/category/power-tools,/category/special-tools', JSON.stringify(g.sameTemplate));
  check('J5. /auth/login and /auth/register are not one template; /, /rentals, /contact and the volatile page pass through',
    planned.includes('/auth/login') && planned.includes('/auth/register') && planned.includes('/') && planned.includes('/rentals') && planned.includes('/contact') && g.pages.some((p) => p.volatile), JSON.stringify(planned));
  const fp = await filterPages({ pages: set, features: ['catalogue', 'cart', 'account', 'contact'], apiKey: undefined });
  check('J6. filterPages plans one page per template and returns the same-template pages apart',
    fp.pages.filter((p) => p.url.includes('/category/')).length === 1 && fp.sameTemplate.length === 3 && fp.pages.length === 7, JSON.stringify({ pages: fp.pages.map((p) => p.url), same: fp.sameTemplate.map((p) => p.url) }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-template-'));
  const file = writeDiscoveryJson(dir, { method: 'browser-crawl', pages: fp.pages, candidates: set.map((p) => { const st = fp.sameTemplate.find((x) => x.url === p.url); return st ? { ...p, sameTemplateAs: st.sameTemplateAs } : p; }), warnings: [] });
  const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { candidates: Array<{ url: string; sameTemplateAs?: string }> };
  fs.rmSync(dir, { recursive: true, force: true });
  check('J7. discovery.json records the same-template page with the representative it shares a template with',
    written.candidates.find((c) => c.url.endsWith('/category/power-tools'))?.sameTemplateAs === `${ORIGIN}/category/hand-tools` && written.candidates.find((c) => c.url.endsWith('/category/hand-tools'))?.sameTemplateAs === undefined, JSON.stringify(written.candidates.filter((c) => c.sameTemplateAs)));

  // The crawl page cap counts stable paths only: fourteen volatile product
  // links on the entry page used to fill the cap before /auth/register (one
  // hop behind /auth/login) was reached. Now at most CRAWL_VOLATILE_CAP of
  // them are even loaded and register is a candidate.
  const products = Array.from({ length: 14 }, (_, i) => `/product/01M2TKYPB9C93P8WTG7P7B23${String(i).padStart(2, '0')}`);
  const bodies: Record<string, string> = {
    [`${ORIGIN}/`]: [...products.map((p) => `<a href="${p}">p</a>`), '<a href="/auth/login">Sign in</a>'].join(' '),
    [`${ORIGIN}/auth/login`]: '<a href="/auth/register">Register your account</a>',
    [`${ORIGIN}/auth/register`]: '',
  };
  for (const p of products) bodies[`${ORIGIN}${p}`] = '';
  const requested: string[] = [];
  const fetchFn = async (url: string): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    requested.push(url);
    if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml') || url.endsWith('sitemap_index.xml')) return { ok: false, status: 404, text: async () => '' };
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn: fetchFn as never, crawlDelayMs: 0 });
  const found = r.pages.map((p) => new URL(p.url).pathname);
  check('J8. the crawl rung fired and /auth/register is a candidate although fourteen volatile product links came first',
    r.method === 'crawl' && found.includes('/auth/register') && found.includes('/auth/login'), JSON.stringify({ method: r.method, found }));
  check(`J9. at most CRAWL_VOLATILE_CAP (${CRAWL_VOLATILE_CAP}) volatile pages are loaded or collected; the stable cap (${CRAWL_PAGE_CAP}) is never spent on them`,
    requested.filter((u) => u.includes('/product/')).length <= CRAWL_VOLATILE_CAP && r.pages.filter((p) => p.volatile).length <= CRAWL_VOLATILE_CAP && r.pages.filter((p) => !p.volatile).length <= CRAWL_PAGE_CAP, JSON.stringify({ loaded: requested.filter((u) => u.includes('/product/')).length, volatile: r.pages.filter((p) => p.volatile).length }));

  // SRS features match pages by rule content, not only by name: the toolshop
  // map calls its login and registration rules "account" (R10 to R12).
  const toolshop: RequirementsMap = {
    features: [
      { name: 'catalogue', description: 'Browse and search products with filters and sorting.', rules: [{ id: 'R2', text: 'Typing a term in the search box and submitting shows only products whose name contains the term.', type: 'behavior' }] },
      { name: 'cart', description: 'Manage shopping cart items and totals.', rules: [{ id: 'R6', text: 'Adding a product from its detail page increases the cart count shown in the header.', type: 'behavior' }] },
      { name: 'account', description: 'User login and registration.', rules: [
        { id: 'R10', text: 'Login with a wrong password shows an error and the user stays on the login page.', type: 'behavior' },
        { id: 'R11', text: 'Registration with an already used email address is rejected with an error.', type: 'validation' },
        { id: 'R12', text: 'Submitting the registration form with an empty required field shows a required-field message.', type: 'validation' },
      ] },
      { name: 'contact', description: 'Contact form with validation.', rules: [{ id: 'R13', text: 'The contact form rejects submission when the message field is empty and shows a validation message.', type: 'validation' }] },
    ],
    roles: ['customer', 'admin'], truncated: false,
  };
  const tokens = featureTokenMap(toolshop);
  check('J10. the account feature\'s rule content adds the login and registration tokens to its own',
    tokens['account']!.includes('login') && tokens['account']!.includes('register') && tokens['account']!.includes('account'), JSON.stringify(tokens['account']));
  check('J11. ruleContentTokens reads registration from "Registration ..." and login from "Login with ..."; cart from "cart"; contact from "contact form"',
    ruleContentTokens(toolshop.features[2]!).includes('signup') && ruleContentTokens(toolshop.features[1]!).includes('basket') && ruleContentTokens(toolshop.features[3]!).includes('contact') && !ruleContentTokens(toolshop.features[3]!).includes('login'), JSON.stringify({ account: ruleContentTokens(toolshop.features[2]!), cart: ruleContentTokens(toolshop.features[1]!), contact: ruleContentTokens(toolshop.features[3]!) }));
  const auth = [bc('/auth/login'), bc('/auth/register'), bc('/auth/forgot-password'), bc('/contact')];
  const matched = plainFeatureMatches(auth, toolshop.features.map((f) => f.name), tokens);
  const tagOf = (p: string): string | null => matched.find((m) => m.url.endsWith(p))?.feature ?? null;
  check('J12. with the toolshop map, "account" plain-matches /auth/login AND /auth/register; /contact matches contact; forgot-password matches nothing',
    tagOf('/auth/login') === 'account' && tagOf('/auth/register') === 'account' && tagOf('/contact') === 'contact' && tagOf('/auth/forgot-password') === null, JSON.stringify(matched.map((m) => [m.url, m.feature])));
  check('J13. without the rule-content tokens the name "account" matches neither auth page (the old behaviour, kept as the baseline)',
    plainFeatureMatches(auth, ['account']).length === 0);
}

/* ─── K. run 71d739 D7: a fallback names its reason; billing stops the run ── */
{
  // Run 8 attempt 1's billing error, verbatim (output/localhost/20261102T125106Z-d2c5df events line 13).
  const BILLING_BODY = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }, request_id: 'req_011Cge8fAX6nGC9NzgNUVSgH' };
  const billingError = (): Error => Object.assign(new Error(`400 ${JSON.stringify(BILLING_BODY)}`), { status: 400, error: BILLING_BODY });
  const throwing = (make: () => Error) => {
    let calls = 0;
    return { calls: () => calls, client: { messages: { create: async () => { calls++; throw make(); } } } as never };
  };
  const twelve: DiscoveredPage[] = Array.from({ length: 12 }, (_, i) => ({ url: `https://shop.example/section-${i}`, source: 'crawl' as const }));
  const billing = throwing(billingError);
  let thrown: unknown = null;
  try { await filterPages({ pages: twelve, features: undefined, apiKey: 'fake', client: billing.client }); } catch (err) { thrown = err; }
  check('K1. filterPages throws a billing error from its model client, never a fallback', thrown !== null && /credit balance is too low/.test((thrown as Error).message) && billing.calls() === 1, String(thrown));
  const generic = throwing(() => new Error('socket hang up\nat Something.stack'));
  const g = await filterPages({ pages: twelve, features: undefined, apiKey: 'fake', client: generic.client });
  check('K2. any other model error falls back with its first line as the reason', g.method === 'fallback' && g.fallbackReason === 'socket hang up' && g.pages.length === MAX_PAGES_NO_FEATURES, JSON.stringify({ method: g.method, reason: g.fallbackReason }));
  const noKey = await filterPages({ pages: twelve, features: undefined, apiKey: undefined });
  const prevKey = process.env.ANTHROPIC_API_KEY;
  check('K3. the no-key fallback names its reason', noKey.method === 'fallback' && noKey.fallbackReason === 'no API key', JSON.stringify(noKey.fallbackReason));
  const emptyPick = { messages: { create: async () => ({ content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) } } as never;
  const ep = await filterPages({ pages: twelve, features: undefined, apiKey: 'fake', client: emptyPick });
  check('K4. an empty model pick names its reason', ep.method === 'fallback' && ep.fallbackReason === 'the model pick named no usable URL', JSON.stringify(ep.fallbackReason));

  // Through explore(): a discovery run whose crawl finds more pages than the cap.
  const pagesHtml = (links: string): string => `<!doctype html><html lang="en"><head><title>Shop</title></head><body><main><h1>Shop</h1><label for="q">Search</label><input id="q">${links}</main></body></html>`;
  const sections = Array.from({ length: 9 }, (_, i) => `/section-${i}`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pagesHtml(u.pathname === '/' ? sections.map((p) => `<a href="${p}">${p}</a>`).join(' ') : '<a href="/">Home</a>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  // Nothing may leave the machine: the real client, if any stage reached it, hits a closed local port.
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-page-filter-k-'));
  const agentCwd = process.cwd();
  process.chdir(tmp);
  const runExplore = async (client: unknown, label: string) => {
    const messages: string[] = [];
    let error: Error | null = null;
    try {
      await explore({ url: site, language: 'ts', outDir: path.join(tmp, label), discover: true, model: 'claude-opus-4-7', maxUsd: 1, loginPreflightDone: true, skipStability: true, pageFilterClient: client as never, onEvent: (e) => { if (e.type === 'message') messages.push(e.text); } });
    } catch (err) { error = err as Error; }
    return { messages, error, outDir: path.join(tmp, label) };
  };
  try {
    const billed = throwing(billingError);
    const r = await runExplore(billed.client, 'billing');
    const stop = r.messages.find((m) => m.startsWith('Run stopped: billing/credit exhaustion (400 '));
    check('K5. through explore(): the billing error at the page filter stops the run with the billing stop line and a checkpoint',
      billed.calls() === 1 && !!stop && stop.includes('Your credit balance is too low') && /State saved\. Resume with: npm run explore -- --resume .*checkpoint\.json$/.test(stop) && r.error?.message === stop && fs.existsSync(path.join(r.outDir, 'checkpoint.json')),
      JSON.stringify({ calls: billed.calls(), error: r.error?.message, messages: r.messages.slice(-6) }));
    check('K6. no "(deterministic fallback" line appears, with or without a reason, and nothing was planned', !r.messages.some((m) => m.includes('deterministic fallback')) && !r.messages.some((m) => m.startsWith('Planner')), JSON.stringify(r.messages));
    const other = throwing(() => new Error('socket hang up'));
    const o = await runExplore(other.client, 'other');
    const narrowed = o.messages.find((m) => m.startsWith('discovery: ') && m.includes('narrowed to'));
    check('K7. any other filter error still falls back, and the discovery line names the reason', narrowed === 'discovery: 10 page(s) narrowed to 5 (deterministic fallback: socket hang up)', JSON.stringify(o.messages.filter((m) => m.startsWith('discovery:'))));
  } finally {
    process.chdir(agentCwd);
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the page filter passes small sets through, falls back deterministically to the shallowest unique pages, and validates every model pick against the input.');
