import { describe, expect, it, vi, beforeAll } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import {
  billingQuery,
  fetchGoogleBilling,
  getGoogleSpend,
  invoiceMonth,
  parseBillingTable,
  parseServiceAccount,
} from './google';
import type { FetchLike } from './types';

/**
 * The Google billing-export read. The fake token endpoint VERIFIES the signed
 * assertion with the matching public key, so a broken JWT fails here rather
 * than in production with a 400 from Google.
 */

const TABLE = 'feral-billing.billing_export.gcp_billing_export_v1_01ABCD_234567_89EFGH';
const NOW = new Date('2026-11-02T15:30:00Z');

let saJson = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  publicKey = pair.publicKey;
  saJson = JSON.stringify({
    type: 'service_account',
    client_email: 'admin-billing@feral-billing.iam.gserviceaccount.com',
    private_key: await exportPKCS8(pair.privateKey),
  });
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeGoogle(rows: Array<[string, string, string, string]>, overrides: Partial<Record<'token' | 'query', Response>> = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (overrides.token) return overrides.token;
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      const { payload } = await jwtVerify(assertion, publicKey, {
        issuer: 'admin-billing@feral-billing.iam.gserviceaccount.com',
        audience: 'https://oauth2.googleapis.com/token',
      });
      expect(payload.scope).toBe('https://www.googleapis.com/auth/bigquery.readonly');
      return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
    }
    if (overrides.query) return overrides.query;
    return new Response(
      JSON.stringify({ jobComplete: true, rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })) })
    );
  };
  return { fetchImpl, calls };
}

describe('config parsing', () => {
  it('accepts project.dataset.table and refuses anything that could escape the backticks', () => {
    expect(parseBillingTable(TABLE)).toEqual({ project: 'feral-billing', fqn: TABLE });
    for (const bad of ['dataset.table', 'p.d.t`; DROP', 'proj-1.d.t x', 'Proj.d.t', 'feral-billing.d.t`']) {
      expect(() => parseBillingTable(bad)).toThrow(/project\.dataset\.table/);
    }
  });

  it('reads the service account as raw JSON or base64 JSON, and says which field is missing', () => {
    expect(parseServiceAccount(saJson).client_email).toMatch(/@feral-billing/);
    expect(parseServiceAccount(Buffer.from(saJson).toString('base64')).client_email).toMatch(/@feral-billing/);
    expect(() => parseServiceAccount('not json')).toThrow(/neither JSON nor base64/);
    expect(() => parseServiceAccount('{"client_email":"a@b.co"}')).toThrow(/private_key/);
  });

  it('uses the Pacific invoice month — the first UTC hours of a month are still last month', () => {
    expect(invoiceMonth(NOW)).toBe('202611');
    expect(invoiceMonth(new Date('2026-11-01T05:00:00Z'))).toBe('202610');
    expect(invoiceMonth(new Date('2026-11-01T09:00:00Z'))).toBe('202611');
  });

  it('nets credits and bounds the scan by partition', () => {
    const q = billingQuery(TABLE);
    expect(q).toContain(`FROM \`${TABLE}\``);
    expect(q).toContain('UNNEST(credits)');
    expect(q).toContain('invoice.month = @month');
    expect(q).toContain('_PARTITIONTIME');
  });
});

describe('fetchGoogleBilling', () => {
  it('signs a JWT, runs the query in the table’s project with the month as a parameter, nets credits', async () => {
    const { fetchImpl, calls } = fakeGoogle([
      ['Maps API', 'EUR', '42.5', '-40'],
      ['Places API (New)', 'EUR', '10', '-2.25'],
    ]);
    const d = await fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl });
    expect(calls[1].url).toBe('https://bigquery.googleapis.com/bigquery/v2/projects/feral-billing/queries');
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer ya29.test');
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body.useLegacySql).toBe(false);
    expect(body.queryParameters[0]).toEqual({
      name: 'month',
      parameterType: { type: 'STRING' },
      parameterValue: { value: '202611' },
    });
    expect(d).toEqual({
      invoiceMonth: '202611',
      currency: 'EUR',
      grossAmount: 52.5,
      creditsAmount: -42.25,
      netAmount: 10.25,
      byService: [
        { service: 'Places API (New)', netAmount: 7.75 },
        { service: 'Maps API', netAmount: 2.5 },
      ],
    });
  });

  it('reports an empty month as zero with an unknown currency, not as USD', async () => {
    const d = await fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: fakeGoogle([]).fetchImpl });
    expect(d.netAmount).toBe(0);
    expect(d.currency).toBe('unknown');
  });

  it('throws Google’s own error sentence on a refused token or query', async () => {
    const token = fakeGoogle([], {
      token: new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 }),
    });
    await expect(fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: token.fetchImpl })).rejects.toThrow(
      'Google token exchange HTTP 400: Invalid JWT Signature.'
    );
    const query = fakeGoogle([], {
      query: new Response(JSON.stringify({ error: { message: 'Access Denied: Table feral-billing:billing_export' } }), { status: 403 }),
    });
    await expect(fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: query.fetchImpl })).rejects.toThrow(
      /BigQuery query HTTP 403: Access Denied/
    );
    const html = fakeGoogle([], { query: new Response('<html>bad gateway</html>', { status: 502 }) });
    await expect(fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: html.fetchImpl })).rejects.toThrow(
      'BigQuery query HTTP 502: <html>bad gateway</html>'
    );
  });

  it('refuses an unfinished job and a month that mixes currencies', async () => {
    const slow = fakeGoogle([], { query: new Response(JSON.stringify({ jobComplete: false })) });
    await expect(fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: slow.fetchImpl })).rejects.toThrow(
      /did not finish/
    );
    const mixed = fakeGoogle([
      ['A', 'EUR', '1', '0'],
      ['B', 'USD', '1', '0'],
    ]);
    await expect(fetchGoogleBilling({ saKeyJson: saJson, table: TABLE, now: NOW, fetchImpl: mixed.fetchImpl })).rejects.toThrow(
      /mixes currencies/
    );
  });

  it('says so when the private key is not a key', async () => {
    const bad = JSON.stringify({ client_email: 'a@b.co', private_key: 'nope' });
    await expect(fetchGoogleBilling({ saKeyJson: bad, table: TABLE, now: NOW, fetchImpl: fakeGoogle([]).fetchImpl })).rejects.toThrow(
      /not a valid PKCS#8/
    );
  });
});

describe('getGoogleSpend', () => {
  it('names exactly the missing variables and makes no call', async () => {
    const fetchImpl = vi.fn();
    expect(await getGoogleSpend({ env: {}, fetchImpl })).toEqual({
      status: 'not_configured',
      missing: ['GOOGLE_BILLING_SA_KEY_JSON', 'GOOGLE_BILLING_EXPORT_TABLE'],
    });
    expect(await getGoogleSpend({ env: { GOOGLE_BILLING_EXPORT_TABLE: TABLE }, fetchImpl })).toEqual({
      status: 'not_configured',
      missing: ['GOOGLE_BILLING_SA_KEY_JSON'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns any failure into an error state, never a number', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await getGoogleSpend({
      env: { GOOGLE_BILLING_SA_KEY_JSON: saJson, GOOGLE_BILLING_EXPORT_TABLE: 'bad' },
      now: NOW,
      fetchImpl: fakeGoogle([]).fetchImpl,
    });
    expect(r.status).toBe('error');
    expect(r.status === 'error' && r.message).toMatch(/project\.dataset\.table/);
  });

  it('runs through the injected cache, keyed by table and invoice month', async () => {
    const keys: string[] = [];
    const r = await getGoogleSpend({
      env: { GOOGLE_BILLING_SA_KEY_JSON: saJson, GOOGLE_BILLING_EXPORT_TABLE: TABLE },
      now: NOW,
      fetchImpl: fakeGoogle([['Maps API', 'USD', '3', '-1']]).fetchImpl,
      cache: async (key, fn) => {
        keys.push(key);
        return fn();
      },
    });
    expect(keys).toEqual([`google-billing:${TABLE}:202611`]);
    expect(r).toMatchObject({ status: 'ok', data: { netAmount: 2, currency: 'USD' } });
  });
});
