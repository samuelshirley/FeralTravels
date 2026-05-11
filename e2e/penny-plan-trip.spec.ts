import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { createBlankPlanningTrip, countLegs } from './fixtures/test-trip';

const ANTHROPIC_CONFIGURED = !!process.env.ANTHROPIC_API_KEY?.trim();

/**
 * End-to-end Penny: send the canonical Girona → Berlin prompt, wait for
 * the SSE stream to finish, then assert structural properties of the
 * resulting plan. We deliberately do NOT compare Penny's prose against
 * a baseline — Anthropic's wording drifts run-to-run and a fuzzy match
 * would either be too loose to catch real regressions or so tight it
 * fails on harmless rephrasing. The structural assertions are what
 * actually matter to the user (did Penny return SOMETHING coherent
 * that we could persist and render?).
 *
 * What we assert:
 *   - Penny returns a non-empty assistant message
 *   - At least 3 legs were created on the trip (Girona → … → Berlin
 *     across multiple days; <3 means Penny gave up or only acknowledged
 *     the prompt)
 *   - The chat shows the "Changes applied to trip" success badge
 *   - The map renders with the right leg count after the plan applies
 *   - Penny's response mentions the route's anchor place names
 *     (Girona, Berlin) — these are extracted from the user's prompt and
 *     should appear verbatim in any sensible plan
 *
 * What we don't assert:
 *   - The exact wording of Penny's reply (drifts run-to-run)
 *   - Specific waypoints or distances (depends on Anthropic's planning)
 *   - Order of legs (Penny may rearrange to optimise)
 *
 * This test really does call Anthropic and burn real spend (~$0.05–0.20
 * per run depending on iteration count). Worth it to catch a broken
 * planner before it hits production.
 *
 * Prompt design: the request must be specific enough that Penny commits to
 * the planning pipeline immediately. Open-ended or physically impossible asks
 * (e.g. "only gravel across Europe") trigger discovery / routing-honesty
 * replies instead of tools — the test would time out without "Changes applied"
 * even though the product is behaving correctly.
 */
test.describe('Penny — submit a trip plan', () => {
  test.skip(!ANTHROPIC_CONFIGURED, 'ANTHROPIC_API_KEY not set — skipped (set key to run Penny E2E)');

  // Anthropic streams can take 30–60s end-to-end on a complex plan; the
  // tool-use loop adds another 10–20s of Google Places lookups. Generous
  // timeout so we don't false-fail on a slow upstream.
  test.setTimeout(180_000);

  const PROMPT =
    'Plan a driving route from Girona, Spain to Berlin, Germany over 14 days. ' +
    'Route through the Alps: Italy into Austria, scenic where Google Directions can still find paved roads. ' +
    'If a segment is tight on time, keep the itinerary feasible within the 14 days.';

  test('Girona → Berlin plan creates legs, applies changes, and renders on the map', async ({
    page,
  }) => {
    // Pre-create the trip with onboarding_state='done' so the chat
    // composer is the first thing visible — we don't want this test to
    // also exercise the onboarding wizard (covered indirectly by the
    // existing-trip + vehicle tests).
    const { tripId } = await createBlankPlanningTrip('Penny Submit Test');

    await loginAsFixtureUser(page, { redirectTo: `/trips/${tripId}` });

    // Wait for the workspace to settle. The chat composer's textarea is
    // identifiable by its placeholder — see ChatPanel.tsx.
    const composer = page.getByPlaceholder('Ask Penny…');
    await expect(composer).toBeVisible({ timeout: 20_000 });

    // Type the prompt and submit. The send button has aria-label="Send".
    await composer.fill(PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The user bubble is rendered optimistically immediately — confirm
    // the SSE pipe took the message before we wait on the response.
    await expect(page.locator('text=' + PROMPT.slice(0, 40))).toBeVisible({ timeout: 5_000 });

    // Wait for the assistant's success badge to appear. The badge is
    // appended to the assistant bubble only after the terminal
    // `applied` SSE event arrived AND appliedCount > 0 — i.e. Penny
    // proposed changes that the server successfully wrote to the DB.
    // Times out if the stream collapsed, the model returned no
    // changes, or the apply pipeline rejected them.
    await expect(page.locator('text=Changes applied to trip')).toBeVisible({
      timeout: 150_000,
    });

    // Now assert the plan actually has legs in it. We re-read straight
    // from the DB rather than the UI because the itinerary list is
    // virtualised (lazy-renders the first 20) and counting visible
    // cards undercounts long plans.
    const legs = await countLegs(tripId);
    expect(
      legs,
      `Penny returned no legs — plan may have collapsed or only acknowledged the prompt (got ${legs}).`,
    ).toBeGreaterThanOrEqual(3);

    // Refresh the workspace so legs Penny just wrote land in the
    // itinerary + map (the in-memory state is also updated via
    // onTripUpdated, but a router.refresh-style reload is the most
    // robust signal that the PERSISTED state is correct).
    await page.reload();

    const legCards = page.getByTestId('leg-card');
    await expect(legCards.first()).toBeVisible({ timeout: 30_000 });
    const visible = await legCards.count();
    expect(visible).toBeGreaterThanOrEqual(3);

    const map = page.getByTestId('trip-map');
    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 30_000 });
    const mapLegCount = await map.getAttribute('data-leg-count');
    expect(Number(mapLegCount)).toBeGreaterThanOrEqual(3);

    // Penny's response (or the leg titles she generated) should mention
    // the route's anchor place names. We check across the visible chat
    // body + the leg cards together so a model that frontloads place
    // names in the bubble or in the leg titles both pass.
    const pageText = (await page.locator('body').innerText()).toLowerCase();
    expect(pageText, 'expected response/legs to mention Girona').toContain('girona');
    expect(pageText, 'expected response/legs to mention Berlin').toContain('berlin');
  });
});
