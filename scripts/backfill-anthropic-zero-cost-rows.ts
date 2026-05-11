/**
 * Backfill `usage_events.cost_microcents` for `provider = 'anthropic'` rows that
 * were stored as $0 while non-zero token counts exist (legacy estimator gaps).
 *
 * Recomputes cost with `estimateAnthropicCostUsd` using stored `input_tokens`
 * and `output_tokens` only (cache write/read counts are not persisted separately
 * on older rows; treating merged input as billable input may slightly overshoot
 * vs Anthropic when heavy prompt-cache reads dominated — still far better than $0).
 *
 * Run: `npx tsx scripts/backfill-anthropic-zero-cost-rows.ts`
 * Requires DATABASE_URL in `.env`. Dry-run: prefix with `DRY_RUN=1`.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, or, sql } from 'drizzle-orm';
import { usageEvents } from '@/server/db/schema';
import {
  dollarsToMicrocents,
  estimateAnthropicCostUsd,
} from '@/lib/anthropicCostEstimate';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before running.');
  }
  const dryRun = process.env.DRY_RUN === '1';

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  const rows = await db
    .select({
      id: usageEvents.id,
      model: usageEvents.model,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costMicrocents: usageEvents.costMicrocents,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, 'anthropic'),
        or(eq(usageEvents.costMicrocents, 0), sql`${usageEvents.costMicrocents} IS NULL`),
        sql`(COALESCE(${usageEvents.inputTokens}, 0) + COALESCE(${usageEvents.outputTokens}, 0)) > 0`
      )
    );

  console.log(`Found ${rows.length} anthropic row(s) with $0 cost but token counts.`);

  let updated = 0;
  for (const row of rows) {
    const model = row.model ?? 'claude-sonnet-4-20250514';
    const inp = row.inputTokens ?? 0;
    const out = row.outputTokens ?? 0;
    const usd = estimateAnthropicCostUsd(model, inp, out, 0, 0);
    const mc = dollarsToMicrocents(usd);
    if (mc === 0) {
      console.warn(`Skip id=${row.id}: estimate still $0 for model=${model} tokens=${inp}/${out}`);
      continue;
    }
    if (dryRun) {
      console.log(`DRY_RUN would set id=${row.id} cost_microcents=${mc} (${usd.toFixed(6)} USD)`);
    } else {
      await db.update(usageEvents).set({ costMicrocents: mc }).where(eq(usageEvents.id, row.id));
    }
    updated += 1;
  }

  console.log(dryRun ? `DRY_RUN: ${updated} row(s) would be updated.` : `Updated ${updated} row(s).`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
