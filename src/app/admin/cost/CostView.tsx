import type { AnthropicCostData, GoogleBillingData, ProviderSpend } from '@/server/providerSpend/types';
import type { GoogleBillableSummary } from '@/server/repos/usage';
import { ANTHROPIC_COST_URL } from '@/server/providerSpend/anthropic';
import { GOOGLE_BILLING_REPORTS_URL } from '@/server/providerSpend/google';
import { fmtUsd, type Read } from '../tiles';
import styles from '../admin.module.css';

export interface EstimateRow {
  provider: string;
  requests: number;
  microcents: number;
}

function money(amount: number, currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) return amount.toFixed(2);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function ProviderState({ spend, source }: { spend: ProviderSpend<unknown>; source: string }) {
  if (spend.status === 'not_configured') {
    return (
      <div className={styles.notice} data-testid="provider-not-configured">
        Not configured — set{' '}
        {spend.missing.map((name, i) => (
          <span key={name}>
            {i > 0 && ' and '}
            <code>{name}</code>
          </span>
        ))}{' '}
        to read {source}.
      </div>
    );
  }
  if (spend.status === 'error') {
    return (
      <div className={styles.noticeDanger} data-testid="provider-error">
        {source} read failed: {spend.message}
      </div>
    );
  }
  return null;
}

/**
 * The Cost tile's screen. Three blocks, in order of trust: what Anthropic
 * billed, what Google billed, and — last, labelled — our own estimate, kept
 * because it is the only view that splits spend by FEATURE (the provider tag
 * on each `usage_events` row), which neither provider can.
 */
export default function CostView({
  anthropic,
  google,
  estimate,
}: {
  anthropic: ProviderSpend<AnthropicCostData>;
  google: ProviderSpend<GoogleBillingData>;
  estimate: Read<{ rows: EstimateRow[]; googleMonth: GoogleBillableSummary }>;
}) {
  return (
    <>
      <section className={styles.card} data-testid="cost-anthropic">
        <h2 className={styles.cardTitle}>
          Anthropic — billed{' '}
          <a href={ANTHROPIC_COST_URL} target="_blank" rel="noopener noreferrer" className={styles.seeAllLink}>
            Console ↗
          </a>
        </h2>
        <ProviderState spend={anthropic} source="Anthropic's cost report" />
        {anthropic.status === 'ok' && (
          <>
            <p className={styles.subtle}>
              Whole organisation, every key (prod, CI, dev). UTC days; today is partial. Projection:{' '}
              {fmtUsd(anthropic.data.projectedMonthUsd)}/mo from the 7 full days ({fmtUsd(anthropic.data.fullDays7Usd)}) × 30/7.
            </p>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>UTC day</th>
                    <th className={styles.num}>Billed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...anthropic.data.days].reverse().map((d, i) => (
                    <tr key={d.date}>
                      <td>
                        {d.date}
                        {i === 0 ? ' (today, so far)' : ''}
                      </td>
                      <td className={styles.num}>{fmtUsd(d.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className={styles.cardTitle}>
              By line, same 8 days
            </h3>
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="cost-anthropic-lines">
                <tbody>
                  {anthropic.data.byLine.map((l) => (
                    <tr key={l.description}>
                      <td>{l.description}</td>
                      <td className={styles.num}>{fmtUsd(l.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className={styles.card} data-testid="cost-google">
        <h2 className={styles.cardTitle}>
          Google — billed{' '}
          <a href={GOOGLE_BILLING_REPORTS_URL} target="_blank" rel="noopener noreferrer" className={styles.seeAllLink}>
            Billing reports ↗
          </a>
        </h2>
        <ProviderState spend={google} source="the Cloud Billing export" />
        {google.status === 'ok' && (
          <>
            <p className={styles.subtle}>
              Invoice month {google.data.invoiceMonth}: gross {money(google.data.grossAmount, google.data.currency)}, credits{' '}
              {money(google.data.creditsAmount, google.data.currency)}, net {money(google.data.netAmount, google.data.currency)}.
              The export trails real usage by hours.
            </p>
            {google.data.byService.length === 0 ? (
              <div className={styles.empty}>No billed rows this month yet.</div>
            ) : (
              <table className={styles.table} data-testid="cost-google-services">
                <tbody>
                  {google.data.byService.map((s) => (
                    <tr key={s.service}>
                      <td>{s.service}</td>
                      <td className={styles.num}>{money(s.netAmount, google.data.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <section className={styles.card} data-testid="cost-estimate">
        <h2 className={styles.cardTitle}>Internal estimate — not a bill</h2>
        <p className={styles.subtle}>
          Our list-price math over prod <code>usage_events</code>, last 7 days, per provider tag. It misses every call made from
          CI previews and local dev, so it undercounts the bills above. Use it to see which feature burns tokens, not what we owe.
        </p>
        {!estimate.ok ? (
          <div className={styles.noticeDanger}>Estimate read failed: {estimate.error}</div>
        ) : estimate.value.rows.length === 0 ? (
          <div className={styles.empty}>No usage rows in the last 7 days.</div>
        ) : (
          <table className={styles.table} data-testid="cost-estimate-rows">
            <thead>
              <tr>
                <th>Provider tag</th>
                <th className={styles.num}>Requests</th>
                <th className={styles.num}>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {[...estimate.value.rows]
                .sort((a, b) => b.microcents - a.microcents)
                .map((r) => (
                  <tr key={r.provider}>
                    <td>{r.provider}</td>
                    <td className={styles.num}>{r.requests.toLocaleString('en-US')}</td>
                    <td className={styles.num}>{fmtUsd(r.microcents / 1e8)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        {estimate.ok && (
          <p className={styles.subtle}>
            Google Places this month, estimated: {fmtUsd(estimate.value.googleMonth.grossUsd)} gross,{' '}
            {fmtUsd(estimate.value.googleMonth.billableUsd)} after per-SKU free allowances.
          </p>
        )}
      </section>
    </>
  );
}
