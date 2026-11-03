/** How an error at an Anthropic call site should end the run. */
export interface StopClassification {
  kind: 'billing' | 'api' | 'other';
  reason: string;
}

const BILLING_RE = /credit balance|insufficient credit|insufficient_quota|billing|purchase (more )?credits|payment required|plans & billing/i;
const API_RE = /overloaded|rate.?limit|too many requests|connection (error|refused|reset)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|internal server error|service unavailable|api_error/i;
const API_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Classify an error thrown by an Anthropic call site. 'billing' (credit
 * exhaustion) and 'api' (persistent API failure, surfacing means the SDK's
 * own retries are exhausted) end the run CLEANLY: completed work is salvaged,
 * the checkpoint is written, and the resume hint prints. 'other' is a real
 * bug and still throws.
 */
export function classifyRunError(err: unknown): StopClassification {
  const e = err as { message?: string; status?: number; error?: { error?: { type?: string; message?: string } } };
  const message = [
    e?.message ?? '',
    e?.error?.error?.type ?? '',
    e?.error?.error?.message ?? '',
  ].join(' ');
  if (BILLING_RE.test(message)) {
    return { kind: 'billing', reason: `billing/credit exhaustion (${firstLine(e?.message) || 'credit balance too low'})` };
  }
  if ((typeof e?.status === 'number' && API_STATUSES.has(e.status)) || API_RE.test(message)) {
    return { kind: 'api', reason: `persistent API failure (${firstLine(e?.message) || `HTTP ${e?.status}`})` };
  }
  return { kind: 'other', reason: firstLine(e?.message) || 'unknown error' };
}

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n')[0]?.trim() ?? '';
}

/**
 * True for an error a stage must never turn into a fallback: billing or
 * credit exhaustion (invariant 79; run 8 attempt 1's page filter printed it
 * as "deterministic fallback").
 */
export function isBillingError(err: unknown): boolean {
  return classifyRunError(err).kind === 'billing';
}
