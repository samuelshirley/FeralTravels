import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { FetchLike, GoogleBillingData, ProviderSpend } from './types';

/**
 * Google spend as GOOGLE reports it: the Cloud Billing export to BigQuery.
 *
 * Google has no "what is my bill" REST endpoint. The Cloud Billing API returns
 * prices and accounts, not spend; the only machine-readable source of real cost
 * is the billing export, which writes every line of the invoice into a BigQuery
 * table. So this reads that table — month to date, net of credits (the Maps
 * free allowances arrive as credits) — with a service account that can do
 * nothing but read that dataset and run query jobs.
 *
 * Unconfigured, it says so. It never substitutes `getGoogleBillableThisMonth`,
 * our per-SKU list-price estimate: that is a different number, and it lives on
 * the cost page labelled as an estimate. Setup: `scripts/google-billing-setup.sh`.
 *
 * The export lags (Google: "throughout the day", typically hours), so this is
 * cached for ten minutes and labelled as lagging.
 */

export const GOOGLE_BILLING_SA_ENV = 'GOOGLE_BILLING_SA_KEY_JSON';
export const GOOGLE_BILLING_TABLE_ENV = 'GOOGLE_BILLING_EXPORT_TABLE';
export const GOOGLE_BILLING_REPORTS_URL = 'https://console.cloud.google.com/billing/reports' as const;
export const GOOGLE_SPEND_REVALIDATE_S = 600;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';

const serviceAccount = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

/**
 * `project.dataset.table`. The table name is interpolated into SQL — BigQuery
 * cannot parameterise identifiers — so this pattern is the injection boundary:
 * letters, digits, `_` and `-` (project ids), nothing that can close a backtick.
 */
const TABLE_RE = /^([a-z][a-z0-9-]{4,61}[a-z0-9])\.([A-Za-z0-9_]{1,1024})\.([A-Za-z0-9_]{1,1024})$/;

export function parseBillingTable(value: string): { project: string; fqn: string } {
  const m = TABLE_RE.exec(value.trim());
  if (!m) {
    throw new Error(
      `${GOOGLE_BILLING_TABLE_ENV} must be project.dataset.table (got "${value.slice(0, 80)}")`
    );
  }
  return { project: m[1], fqn: `${m[1]}.${m[2]}.${m[3]}` };
}

/** Raw JSON or base64 of it — Vercel's UI mangles neither, but a shell might. */
export function parseServiceAccount(value: string): z.infer<typeof serviceAccount> {
  const trimmed = value.trim();
  const text = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${GOOGLE_BILLING_SA_ENV} is neither JSON nor base64-encoded JSON`);
  }
  const parsed = serviceAccount.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${GOOGLE_BILLING_SA_ENV} is missing client_email or private_key`);
  }
  return parsed.data;
}

/**
 * The invoice month the billing account is on right now. Google bills in
 * Pacific time, so for the first hours of a UTC month the invoice is still the
 * previous one.
 */
export function invoiceMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}${m}`;
}

/**
 * Net cost per service for one invoice month. `cost` is gross; `credits` is an
 * array of negative amounts. The partition filter bounds the scan: a month's
 * rows are ingested within it or shortly after, never 40 days before today.
 */
export function billingQuery(fqn: string): string {
  return [
    'SELECT service.description AS service, currency,',
    '  SUM(cost) AS gross,',
    '  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits',
    `FROM \`${fqn}\``,
    'WHERE invoice.month = @month',
    '  AND DATE(_PARTITIONTIME) >= DATE_SUB(CURRENT_DATE(), INTERVAL 40 DAY)',
    'GROUP BY service, currency',
    'ORDER BY gross DESC',
  ].join('\n');
}

const tokenResponse = z.object({ access_token: z.string() });
const queryResponse = z.object({
  jobComplete: z.boolean(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.string().nullable() })) })).optional(),
});

const googleError = z.object({
  error: z.union([z.object({ message: z.string() }), z.string()]).optional(),
  error_description: z.string().optional(),
});

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON: the caller falls back to the raw text
  }
}

/** Google's own error sentence when it sent one, the raw body when it did not. */
async function readError(res: Response): Promise<string> {
  const text = await res.text();
  const parsed = googleError.safeParse(jsonOrNull(text));
  if (parsed.success) {
    if (typeof parsed.data.error === 'object') return parsed.data.error.message;
    if (parsed.data.error_description) return parsed.data.error_description;
  }
  return text.slice(0, 300);
}

export async function fetchGoogleBilling(opts: {
  saKeyJson: string;
  table: string;
  now: Date;
  fetchImpl: FetchLike;
}): Promise<GoogleBillingData> {
  const sa = parseServiceAccount(opts.saKeyJson);
  const { project, fqn } = parseBillingTable(opts.table);
  const month = invoiceMonth(opts.now);

  const iat = Math.floor(opts.now.getTime() / 1000);
  const key = await importPKCS8(sa.private_key, 'RS256').catch(() => {
    throw new Error(`${GOOGLE_BILLING_SA_ENV}: private_key is not a valid PKCS#8 RSA key`);
  });
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);

  const tokenRes = await opts.fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange HTTP ${tokenRes.status}: ${await readError(tokenRes)}`);
  }
  const token = tokenResponse.parse(await tokenRes.json()).access_token;

  const queryRes = await opts.fetchImpl(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: billingQuery(fqn),
        useLegacySql: false,
        parameterMode: 'NAMED',
        queryParameters: [
          { name: 'month', parameterType: { type: 'STRING' }, parameterValue: { value: month } },
        ],
        timeoutMs: 20_000,
      }),
      signal: AbortSignal.timeout(25_000),
      cache: 'no-store',
    }
  );
  if (!queryRes.ok) {
    throw new Error(`BigQuery query HTTP ${queryRes.status}: ${await readError(queryRes)}`);
  }
  const parsed = queryResponse.safeParse(await queryRes.json());
  if (!parsed.success) throw new Error('BigQuery returned an unexpected response shape');
  if (!parsed.data.jobComplete) throw new Error('BigQuery billing query did not finish within 20 s');

  const rows = (parsed.data.rows ?? []).map((r) => ({
    service: r.f[0]?.v ?? '(unknown service)',
    currency: r.f[1]?.v ?? '',
    gross: Number(r.f[2]?.v ?? 0),
    credits: Number(r.f[3]?.v ?? 0),
  }));
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) {
    throw new Error(`Billing export mixes currencies (${[...currencies].join(', ')}) in ${month}`);
  }
  const grossAmount = rows.reduce((s, r) => s + r.gross, 0);
  const creditsAmount = rows.reduce((s, r) => s + r.credits, 0);
  return {
    invoiceMonth: month,
    // An empty month has no rows to read the currency from. Said, not guessed.
    currency: rows[0]?.currency || 'unknown',
    grossAmount,
    creditsAmount,
    netAmount: grossAmount + creditsAmount,
    byService: rows
      .map((r) => ({ service: r.service, netAmount: r.gross + r.credits }))
      .sort((a, b) => b.netAmount - a.netAmount),
  };
}

export async function getGoogleSpend(
  deps: {
    env?: Record<string, string | undefined>;
    now?: Date;
    fetchImpl?: FetchLike;
    /** Wraps the fetch in a cache. The page passes Next's; tests pass nothing. */
    cache?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  } = {}
): Promise<ProviderSpend<GoogleBillingData>> {
  const env = deps.env ?? process.env;
  const saKeyJson = env[GOOGLE_BILLING_SA_ENV]?.trim();
  const table = env[GOOGLE_BILLING_TABLE_ENV]?.trim();
  const missing = [
    ...(saKeyJson ? [] : [GOOGLE_BILLING_SA_ENV]),
    ...(table ? [] : [GOOGLE_BILLING_TABLE_ENV]),
  ];
  if (!saKeyJson || !table) return { status: 'not_configured', missing };
  const now = deps.now ?? new Date();
  const run = () => fetchGoogleBilling({ saKeyJson, table, now, fetchImpl: deps.fetchImpl ?? fetch });
  try {
    const data = deps.cache ? await deps.cache(`google-billing:${table}:${invoiceMonth(now)}`, run) : await run();
    return { status: 'ok', data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[providerSpend] Google billing export failed:', message);
    return { status: 'error', message };
  }
}
