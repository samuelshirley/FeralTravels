/**
 * Pull the org's REAL Anthropic usage + cost from the Admin API and lay it
 * beside prod `usage_events`, day by day, key by key, model by model.
 *
 *   npx tsx scripts/anthropic-usage-report.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
 *
 * Why this exists (2026-09-09): the Console billed $21.94 for Sep 1–8 while
 * prod `usage_events` held $1.80. The admin panel cannot be "fixed" — the
 * missing rows were written by CI previews (Neon branch deleted with the PR)
 * and `next dev` on the throwaway cluster, so they no longer exist anywhere
 * but Anthropic. This is the only complete view, and it separates the two
 * possible discrepancies that a single total cannot:
 *   1. ROWS MISSING — Console tokens ≫ prod tokens (the accounting gap).
 *   2. PRICE WRONG  — our list-price math applied to the CONSOLE's own token
 *      counts disagrees with the Console's cost (a pricing-table gap).
 * The per-key table answers "who spent it" now that ANTHROPIC_API_KEY_CI is
 * a separate key (src/lib/anthropicKey.ts).
 *
 * Needs ANTHROPIC_ADMIN_KEY: an ORGANIZATION-scoped key. In this org there is
 * no "Admin keys" page (platform.claude.com/settings/admin-keys is a 404 —
 * checked 2026-09-09); instead Console → Organization settings → API keys →
 * Create key → Scope: **Organization** (the top entry, above the workspaces).
 * A workspace-scoped key (what the app runs on) is refused by these
 * endpoints with 401/403. DATABASE_URL from .env (read-only; safe on prod).
 *
 * Endpoints (verified against platform.claude.com/docs 2026-09-09):
 *   GET /v1/organizations/usage_report/messages  bucket_width=1d, limit≤31,
 *       group_by[]=api_key_id|model → data[].results[]{uncached_input_tokens,
 *       cache_creation{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens},
 *       cache_read_input_tokens, output_tokens, api_key_id, model}
 *   GET /v1/organizations/cost_report  bucket_width=1d, group_by[]=description
 *       → results[]{amount (decimal string), currency, model, token_type, description}
 *   GET /v1/organizations/api_keys → data[]{id, name, status}
 */
import 'dotenv/config';
import fs from 'node:fs';
import postgres from 'postgres';
import { estimateAnthropicCostUsd } from '@/lib/anthropicCostEstimate';

const API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';

type Tokens = { uncached: number; cacheWrite: number; cacheRead: number; output: number };
const zero = (): Tokens => ({ uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const addTo = (t: Tokens, u: Tokens) => {
  t.uncached += u.uncached; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; t.output += u.output;
};
const estimate = (model: string, t: Tokens) =>
  estimateAnthropicCostUsd(model, t.uncached, t.output, t.cacheWrite, t.cacheRead);
const usd = (n: number) => `$${n.toFixed(4)}`;
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** process env → .env.local → .env, skipping empty assignments (the Vercel CLI writes empty ones). */
function envValue(name: string): string | undefined {
  const fromProc = process.env[name];
  if (fromProc && fromProc.trim()) return fromProc.trim();
  for (const file of ['.env.local', '.env']) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (!m) continue;
      const v = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (v) return v;
    }
  }
  return undefined;
}

async function admin<T>(path: string, params: URLSearchParams, key: string): Promise<T> {
  const url = `${API}${path}?${params.toString()}`;
  const res = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': VERSION } });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${res.status} from ${path} — ANTHROPIC_ADMIN_KEY is not accepted by the org endpoints. ` +
        `It must be scoped to the ORGANIZATION (API keys → Create key → Scope: Organization), not a workspace.\n${text}`
    );
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${path}\n${text}`);
  return JSON.parse(text) as T;
}

type Bucket<R> = { starting_at: string; ending_at: string; results: R[] };
type Paged<R> = { data: Bucket<R>[]; has_more: boolean; next_page: string | null };

async function allBuckets<R>(path: string, base: URLSearchParams, key: string): Promise<Bucket<R>[]> {
  const out: Bucket<R>[] = [];
  let page: string | null = null;
  for (;;) {
    const p = new URLSearchParams(base);
    if (page) p.set('page', page);
    const res: Paged<R> = await admin<Paged<R>>(path, p, key);
    out.push(...res.data);
    if (!res.has_more || !res.next_page) return out;
    page = res.next_page;
  }
}

type UsageResult = {
  api_key_id: string | null;
  model: string | null;
  uncached_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  cache_read_input_tokens: number;
  output_tokens: number;
};
type CostResult = {
  amount: string;
  currency: string;
  model: string | null;
  token_type: string | null;
  description: string | null;
  cost_type: string | null;
};
type ApiKey = { id: string; name: string; status: string };

const tokensOf = (r: UsageResult): Tokens => ({
  uncached: r.uncached_input_tokens ?? 0,
  cacheWrite: (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0),
  cacheRead: r.cache_read_input_tokens ?? 0,
  output: r.output_tokens ?? 0,
});

async function main() {
  const key = envValue('ANTHROPIC_ADMIN_KEY');
  if (!key) {
    console.error(
      'ANTHROPIC_ADMIN_KEY is not set.\n' +
        'Create one at https://platform.claude.com/settings/keys → Create key → Scope: Organization\n' +
        '(NOT a workspace — workspace keys cannot read org usage) and add ANTHROPIC_ADMIN_KEY=… to .env.'
    );
    process.exit(1);
  }
  const dbUrl = envValue('DATABASE_URL');
  if (!dbUrl) throw new Error('DATABASE_URL is not set in .env');

  const now = new Date();
  const from = arg('from') ?? `${now.toISOString().slice(0, 7)}-01`;
  const to = arg('to') ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const startingAt = `${from}T00:00:00Z`;
  const endingAt = `${to}T00:00:00Z`;
  const asJson = process.argv.includes('--json');

  // ── Anthropic: keys, usage, cost ────────────────────────────────────────
  const keys = await admin<{ data: ApiKey[] }>('/v1/organizations/api_keys', new URLSearchParams({ limit: '100' }), key);
  const keyName = new Map(keys.data.map((k) => [k.id, `${k.name}${k.status !== 'active' ? ` (${k.status})` : ''}`]));

  const usageParams = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: '1d', limit: '31' });
  usageParams.append('group_by[]', 'api_key_id');
  usageParams.append('group_by[]', 'model');
  const usage = await allBuckets<UsageResult>('/v1/organizations/usage_report/messages', usageParams, key);

  const costParams = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: '1d', limit: '31' });
  costParams.append('group_by[]', 'description');
  const cost = await allBuckets<CostResult>('/v1/organizations/cost_report', costParams, key);

  // ── Prod usage_events ───────────────────────────────────────────────────
  const sql = postgres(dbUrl, { max: 1 });
  const prodRows = await sql<{
    day: string; model: string; rows: string; inp: string; cw: string; cr: string; out: string; usd: string;
  }[]>`
    select to_char((created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day, model,
           count(*)::text as rows, sum(input_tokens)::text as inp,
           sum(cache_creation_input_tokens)::text as cw, sum(cache_read_input_tokens)::text as cr,
           sum(output_tokens)::text as out, (sum(cost_microcents)/1e8)::text as usd
    from usage_events
    where provider = 'anthropic' and created_at >= ${startingAt}::timestamptz and created_at < ${endingAt}::timestamptz
    group by 1, 2 order by 1, 2`;
  await sql.end();

  // ── Aggregate ───────────────────────────────────────────────────────────
  const day = (iso: string) => iso.slice(0, 10);
  const consoleByDay = new Map<string, { tokens: Tokens; estimate: number; byModel: Map<string, Tokens> }>();
  const byKey = new Map<string, { tokens: Tokens; estimate: number; days: Set<string> }>();
  const byKeyDay = new Map<string, Map<string, number>>();
  const consoleByModel = new Map<string, Tokens>();
  for (const b of usage) {
    const d = day(b.starting_at);
    const dayRec = consoleByDay.get(d) ?? { tokens: zero(), estimate: 0, byModel: new Map() };
    consoleByDay.set(d, dayRec);
    for (const r of b.results) {
      const t = tokensOf(r);
      const model = r.model ?? '(unknown)';
      const est = estimate(model, t);
      addTo(dayRec.tokens, t); dayRec.estimate += est;
      const dm = dayRec.byModel.get(model) ?? zero(); addTo(dm, t); dayRec.byModel.set(model, dm);
      const cm = consoleByModel.get(model) ?? zero(); addTo(cm, t); consoleByModel.set(model, cm);
      const kn = r.api_key_id ? keyName.get(r.api_key_id) ?? r.api_key_id : '(no key — Console/Workbench)';
      const kr = byKey.get(kn) ?? { tokens: zero(), estimate: 0, days: new Set() };
      addTo(kr.tokens, t); kr.estimate += est; kr.days.add(d); byKey.set(kn, kr);
      const kd = byKeyDay.get(kn) ?? new Map(); kd.set(d, (kd.get(d) ?? 0) + est); byKeyDay.set(kn, kd);
    }
  }
  const billedByDay = new Map<string, number>();
  const billedByLine = new Map<string, { model: string; tokenType: string; amount: number; currency: string }>();
  for (const b of cost) {
    const d = day(b.starting_at);
    for (const r of b.results) {
      // `amount` is a decimal string in CENTS (measured 2026-09-09: the sum read 2194.03
      // against a Console total of $21.94). The reference page's example only says "USD".
      const amt = Number(r.amount) / 100;
      billedByDay.set(d, (billedByDay.get(d) ?? 0) + amt);
      const lineKey = r.description ?? `${r.model}/${r.token_type}`;
      const line = billedByLine.get(lineKey) ?? { model: r.model ?? '?', tokenType: r.token_type ?? r.cost_type ?? '?', amount: 0, currency: r.currency };
      line.amount += amt; billedByLine.set(lineKey, line);
    }
  }
  const prodByDay = new Map<string, { usd: number; tokens: Tokens; rows: number }>();
  const prodByModel = new Map<string, Tokens>();
  for (const r of prodRows) {
    const t: Tokens = { uncached: +r.inp, cacheWrite: +r.cw, cacheRead: +r.cr, output: +r.out };
    const p = prodByDay.get(r.day) ?? { usd: 0, tokens: zero(), rows: 0 };
    p.usd += +r.usd; addTo(p.tokens, t); p.rows += +r.rows; prodByDay.set(r.day, p);
    const pm = prodByModel.get(r.model) ?? zero(); addTo(pm, t); prodByModel.set(r.model, pm);
  }

  const days = [...new Set([...consoleByDay.keys(), ...billedByDay.keys(), ...prodByDay.keys()])].sort();
  const sumBilled = [...billedByDay.values()].reduce((a, b) => a + b, 0);

  if (asJson) {
    console.log(JSON.stringify({ from, to, usage, cost, prodRows, keys: keys.data }, null, 2));
    return;
  }

  console.log(`\nAnthropic org usage ${from} → ${to} (UTC days). Console "Total cost" for this range: ${usd(sumBilled)}\n`);

  console.log('═══ Per day: what Anthropic billed vs what prod usage_events holds ═══');
  console.table(
    days.map((d) => {
      const c = consoleByDay.get(d); const p = prodByDay.get(d); const billed = billedByDay.get(d) ?? 0;
      return {
        day: d,
        billed: usd(billed),
        our_math_on_console_tokens: usd(c?.estimate ?? 0),
        prod_usage_events: usd(p?.usd ?? 0),
        prod_rows: p?.rows ?? 0,
        unaccounted: usd(billed - (p?.usd ?? 0)),
        console_cache_read: fmtK(c?.tokens.cacheRead ?? 0),
        prod_cache_read: fmtK(p?.tokens.cacheRead ?? 0),
        console_output: fmtK(c?.tokens.output ?? 0),
        prod_output: fmtK(p?.tokens.output ?? 0),
      };
    })
  );

  console.log('═══ Per API key (our list-price math on the Console\'s token counts) ═══');
  console.table(
    [...byKey.entries()].sort((a, b) => b[1].estimate - a[1].estimate).map(([name, k]) => ({
      key: name,
      estimated_usd: usd(k.estimate),
      share: `${((k.estimate / Math.max(1e-9, [...byKey.values()].reduce((a, b) => a + b.estimate, 0))) * 100).toFixed(1)}%`,
      days_active: k.days.size,
      uncached_in: fmtK(k.tokens.uncached), cache_write: fmtK(k.tokens.cacheWrite),
      cache_read: fmtK(k.tokens.cacheRead), output: fmtK(k.tokens.output),
    }))
  );

  console.log('═══ Per key per day (estimated USD) ═══');
  console.table(
    days.map((d) => Object.fromEntries([['day', d], ...[...byKeyDay.entries()].map(([k, m]) => [k, usd(m.get(d) ?? 0)])]))
  );

  console.log('═══ Per model: Console tokens vs prod tokens (rows-missing check) ═══');
  const models = [...new Set([...consoleByModel.keys(), ...prodByModel.keys()])].sort();
  console.table(
    models.map((m) => {
      const c = consoleByModel.get(m) ?? zero(); const p = prodByModel.get(m) ?? zero();
      const total = (t: Tokens) => t.uncached + t.cacheWrite + t.cacheRead + t.output;
      return {
        model: m,
        console_tokens: fmtK(total(c)), prod_tokens: fmtK(total(p)),
        prod_share: `${((total(p) / Math.max(1, total(c))) * 100).toFixed(1)}%`,
        console_cache_read: fmtK(c.cacheRead), console_cache_write: fmtK(c.cacheWrite),
        console_uncached: fmtK(c.uncached), console_output: fmtK(c.output),
      };
    })
  );

  console.log('═══ Billed line items → effective $/MTok vs our pricing table (price-wrong check) ═══');
  console.table(
    [...billedByLine.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([desc, l]) => {
      const t = consoleByModel.get(l.model) ?? zero();
      const tt = l.tokenType.toLowerCase();
      // 'uncached_input_tokens' contains the substring 'cache' — classify by exact bucket first.
      const kind: keyof Tokens | null = tt.startsWith('cache_read') ? 'cacheRead'
        : tt.startsWith('cache_creation') ? 'cacheWrite'
        : tt.startsWith('output') ? 'output'
        : tt.startsWith('uncached') ? 'uncached' : null;
      const tokens = kind ? t[kind] : 0;
      const oneM: Tokens = { ...zero(), ...(kind ? { [kind]: 1e6 } : {}) };
      const ourPerM = kind && tokens > 0 ? estimate(l.model, oneM) : NaN;
      return {
        line: desc, model: l.model, token_type: l.tokenType,
        billed: `${l.amount.toFixed(4)} ${l.currency}`,
        console_tokens: fmtK(tokens),
        billed_per_MTok: tokens > 0 ? (l.amount / (tokens / 1e6)).toFixed(3) : 'n/a',
        our_table_per_MTok: Number.isFinite(ourPerM) ? ourPerM.toFixed(3) : 'n/a',
      };
    })
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
