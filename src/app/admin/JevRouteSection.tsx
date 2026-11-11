import styles from './JevRouteSection.module.css';

/**
 * The route question's week, on /admin — MEASUREMENT ONLY: nothing acts on
 * Jev's route yet (`src/lib/jevRoute.ts`). For each route: how often Jev
 * confidently picked it, how often that matched what Penny's turn then
 * actually did (precision), how many of the messages that needed it Jev
 * caught (coverage), and the dollars a code path would have saved — the SUM
 * of the measured Anthropic cost of the correctly routed turns, read from
 * each turn's own `usage_events` row. With nothing graded it says so and
 * shows no dollar figure.
 *
 * Props are plain data; the types are declared here rather than imported
 * from `server/repos/jev.ts`, which is `server-only`.
 */

type Route = 'add_pasted_place' | 'replace_fuel_stop' | 'off_topic' | 'needs_penny';

export interface JevRouteIntentProps {
  route: Route;
  routedConfident: number;
  correctConfident: number;
  truthCount: number;
  costedRows: number;
  avoidedUsd: number;
}

export interface JevRouteStatsProps {
  days: number;
  compared: number;
  answered: number;
  graded: number;
  ungraded: number;
  erroredTurns: number;
  intents: JevRouteIntentProps[];
  gateOnly: {
    confidentRefusals: number;
    agreed: number;
    haikuSaidT1: number;
    otherRefusalTier: number;
    avoidedUsd: number;
  };
  day: { graded: number; matched: number; byKind: Record<string, number> };
  avgInputTokens: number | null;
}

/** What each route would hand to code instead of Penny, in a few words. */
const LABEL: Record<Route, string> = {
  add_pasted_place: 'Add a pasted Maps place',
  replace_fuel_stop: 'Swap a fuel stop (re-run Finn)',
  off_topic: 'Off-topic (gate only)',
  needs_penny: 'Needs Penny',
};

function usd(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function avoided(i: JevRouteIntentProps): string {
  if (i.route === 'needs_penny') return 'n/a';
  if (i.correctConfident === 0) return '—';
  const missing = i.correctConfident - i.costedRows;
  return missing > 0 ? `${usd(i.avoidedUsd)} (${missing} without a cost row)` : usd(i.avoidedUsd);
}

export default function JevRouteSection({ routes, show }: { routes: JevRouteStatsProps | null; show: boolean }) {
  if (!show) return null;
  if (routes === null) {
    return <p className={styles.error}>Could not read the route measurement.</p>;
  }
  const r = routes;
  if (r.compared === 0) {
    return (
      <p className={styles.line} data-testid="admin-jev-routes">
        Route question: no messages compared in the last {r.days} days.
      </p>
    );
  }
  const g = r.gateOnly;
  const kinds = Object.entries(r.day.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  return (
    <div className={styles.section} data-testid="admin-jev-routes">
      <h3 className={styles.heading}>Route question, last {r.days} days (logged only)</h3>
      <p className={styles.line} data-testid="admin-jev-routes-summary">
        Jev answered the route on {r.answered} of {r.compared} compared messages; {r.graded} graded against what
        Penny&apos;s turn did{r.ungraded > 0 ? `, ${r.ungraded} waiting on a turn` : ''}
        {r.erroredTurns > 0 ? `, ${r.erroredTurns} failed turns left out` : ''}.
        {r.avgInputTokens !== null ? ` ${r.avgInputTokens} input tokens a call on average.` : ''}
      </p>
      {r.graded === 0 ? (
        <p className={styles.line} data-testid="admin-jev-routes-ungraded">
          Nothing graded yet, so no precision and no dollars avoided.
        </p>
      ) : (
        <table className={styles.table} data-testid="admin-jev-routes-table">
          <thead>
            <tr>
              <th className={styles.thLeft}>Route</th>
              <th className={styles.th}>Jev sure</th>
              <th className={styles.th}>Right</th>
              <th className={styles.th}>Precision</th>
              <th className={styles.th}>Needed</th>
              <th className={styles.th}>Coverage</th>
              <th className={styles.th}>Avoided</th>
            </tr>
          </thead>
          <tbody>
            {r.intents.map((i) => (
              <tr key={i.route} data-testid={`admin-jev-route-${i.route}`}>
                <td className={styles.tdLeft}>{LABEL[i.route]}</td>
                <td className={styles.td}>{i.routedConfident}</td>
                <td className={styles.td}>{i.correctConfident}</td>
                <td className={styles.td}>{pct(i.correctConfident, i.routedConfident)}</td>
                <td className={styles.td}>{i.truthCount}</td>
                <td className={styles.td}>{pct(i.correctConfident, i.truthCount)}</td>
                <td className={styles.money} data-testid={`admin-jev-route-${i.route}-avoided`}>
                  {avoided(i)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.line} data-testid="admin-jev-routes-gate">
        Tier: Jev confidently refused {g.confidentRefusals}
        {g.confidentRefusals > 0
          ? ` — Haiku agreed on ${g.agreed} (${pct(g.agreed, g.confidentRefusals)}), let ${g.haikuSaidT1} through as T1, and gave the other refusal on ${g.otherRefusalTier}`
          : ''}
        . Gate-only saving if Jev had decided those: {g.agreed > 0 ? usd(g.avoidedUsd) : '—'} (their measured Haiku
        calls; a refused message never reaches Penny).
      </p>
      {r.day.graded > 0 || kinds ? (
        <p className={styles.line} data-testid="admin-jev-routes-day">
          Day parse on added places: matched Penny&apos;s day on {r.day.matched} of {r.day.graded} (
          {pct(r.day.matched, r.day.graded)}){kinds ? `; forms: ${kinds}` : ''}.
        </p>
      ) : null}
    </div>
  );
}
