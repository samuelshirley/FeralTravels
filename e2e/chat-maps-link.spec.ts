import { test, expect, type Page } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createBlankPlanningTrip, seedCanonicalFixture } from './fixtures/test-trip';

/**
 * A Maps link pasted INTO CHAT lands as a stop, and a destination change does
 * not lose the day's fuel stop.
 *
 * Both halves call Anthropic for real (three Penny turns, ~$0.20–0.40 a run)
 * and both exist because a browser session on 2026-09-04 found them broken:
 *
 *  1. The day card's "Paste GPS or a Maps link" row 500'd on every short link
 *     (`source: google_maps` — coordinate provenance — was forwarded into the
 *     stop's AUTHOR enum). The row is gone, so chat is now the ONLY way to
 *     paste a place, and it goes through a different path entirely:
 *     `resolveMapsLinksInMessage` resolves the link into Penny's context and
 *     she writes the stop through `add_stop`, whose `source` comes from her
 *     own tool enum. This is the only automated proof that path works — and
 *     it uses the SAME short link the bug was found with, because a short
 *     link is a redirect Google only unfolds for a crawler User-Agent, and
 *     that is the half most likely to rot quietly.
 *
 *  2. Changing a leg's destination invalidates its fuel cache (correct: the
 *     old plan was computed for a route that no longer exists). The RE-SOURCE
 *     was what went missing — LegCard deduped its lazy fetch on a signature an
 *     invalidated leg shares with its own first search. A planned stop then
 *     became "No stops yet" with no spinner and stayed that way. This asserts
 *     the leg ends with a fuel stop AGAIN, read from the API, which is the
 *     structural claim: not "invalidate was called", but "the day has fuel".
 *
 * Wording is never asserted — Penny rephrases herself. Shape only.
 */
const SHORT_LINK = 'https://maps.app.goo.gl/E9VYBkjCT1cgCBbt8';
/** Where that link resolves: a park on the edge of Annecy. */
const LINKED_PLACE = /meythet/i;

interface ApiStop {
  id: string;
  stop_type: string;
  name: string;
  status: string;
  source: string | null;
}
interface ApiLeg {
  id: string;
  end_name: string;
  fuel_status: string;
  stops: ApiStop[];
}

async function readLegs(page: Page, tripId: string): Promise<ApiLeg[]> {
  const res = await page.request.get(`/api/trip?tripId=${tripId}`);
  if (!res.ok()) {
    throw new Error(`[e2e/chat-maps-link] GET /api/trip failed (${res.status()}): ${await res.text()}`);
  }
  const body = (await res.json()) as { legs?: ApiLeg[] };
  return body.legs ?? [];
}

async function sendToPenny(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('Ask Penny…');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Her turn is over when the applied badge lands and the dots go.
  await expect(page.getByLabel('Penny is typing')).toBeHidden({ timeout: 180_000 });
}

test.describe('A Maps link in chat', () => {
  test.skip(!process.env.ANTHROPIC_API_KEY?.trim(), 'ANTHROPIC_API_KEY not set');
  test.setTimeout(420_000);

  test('lands as an `other` stop, and a destination change keeps the fuel stop', async ({ page }) => {
    const email = uniqueEmail();
    await seedCanonicalFixture(email);
    const { tripId } = await createBlankPlanningTrip(email, 'Chat Maps Link');
    await login(page, email, `/trips/${tripId}`);

    // One day, 652 km, against the fixture Hilux's 500 km: Finn must place a
    // stop, which is what the second half needs on the board.
    await sendToPenny(page, 'Girona, Spain to Annecy, France, all in one driving day.');
    await expect(page.getByText('Changes applied to trip')).toBeVisible({ timeout: 180_000 });

    const day = page.getByTestId('leg-card').first();
    await expect(day).toBeVisible({ timeout: 30_000 });
    await day.click();
    // Opening the day sources its fuel lazily; wait for Finn, not for the DOM.
    await expect
      .poll(async () => (await readLegs(page, tripId))[0]?.stops.some((s) => s.stop_type === 'fuel'), {
        message: 'the planned day should carry a fuel stop before the edit',
        timeout: 60_000,
      })
      .toBe(true);
    const legId = (await readLegs(page, tripId))[0].id;

    // ── 1. The link, in chat ────────────────────────────────────────────
    await sendToPenny(page, `Add this place as a stop along the way on day 1: ${SHORT_LINK}`);
    await expect
      .poll(
        async () => {
          const legs = await readLegs(page, tripId);
          return legs
            .flatMap((l) => l.stops)
            .find((s) => s.stop_type === 'other' && LINKED_PLACE.test(s.name)) ?? null;
        },
        { message: 'the linked place should land as an `other` stop', timeout: 60_000 },
      )
      .not.toBeNull();
    const added = (await readLegs(page, tripId))
      .flatMap((l) => l.stops)
      .find((s) => s.stop_type === 'other' && LINKED_PLACE.test(s.name))!;
    // The author enum the stops API accepts — never the resolver's provenance.
    expect(['penny', 'user', 'google_places', 'google', 'manual']).toContain(added.source);
    // And it is on screen, in the open day.
    await expect(page.getByText(LINKED_PLACE).first()).toBeVisible({ timeout: 30_000 });

    // ── 2. The destination moves; the fuel stop must come back ─────────
    await sendToPenny(page, 'End day 1 at that place instead of central Annecy.');
    await expect
      .poll(async () => (await readLegs(page, tripId)).find((l) => l.id === legId)?.end_name ?? '', {
        message: 'the leg should now end at the linked place',
        timeout: 60_000,
      })
      .toMatch(LINKED_PLACE);
    await expect
      .poll(
        async () => {
          const leg = (await readLegs(page, tripId)).find((l) => l.id === legId);
          return leg ? `${leg.fuel_status}:${leg.stops.some((s) => s.stop_type === 'fuel')}` : 'gone';
        },
        {
          message: 'the open day must re-source its fuel after the destination change, not sit on "No stops yet"',
          timeout: 90_000,
        },
      )
      .toBe('ready:true');
  });
});
