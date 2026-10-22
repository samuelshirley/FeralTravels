// Plant Penny's dead end on ${ACCOUNT_EMAIL}'s trip: the driver's message, then
// the "couldn't apply that cleanly" reply carrying the structured
// `fallback_meta` flag — the two rows the replan route writes for a fallback
// turn (src/test/pg/replanFallback.test.ts holds the endpoint to that shape).
//
// ── Why the fallback is planted rather than produced ──────────────────────
//
// Penny falls back when the model returns nothing usable, which cannot be made
// to happen on demand, and asking costs an Anthropic call per run. What the
// APP does is real: it loads the transcript from the API and decides from the
// flag whether to offer "Try again".
//
// ── Why the planted message is junk ───────────────────────────────────────
//
// Tapping "Try again" resends it for real, through the normal send path. A
// message the gate's deterministic deny rules refuse ("SELECT … FROM …", sql)
// gets its answer — the T3 line — with no model call, so this non-AI flow can
// tap the button and see the resend answered without spending anything. The
// strike it earns lands on this flow's own account (seed-account.js).
//
// /api/test/* is fixture DATA: off on production with no override, locked by
// the per-run HMAC on a preview, and it refuses any address outside
// FIXTURE_EMAIL_PATTERN or a trip that address does not own.

var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var res = http.post(BASE_URL + '/api/test/turn', {
  headers: headers,
  body: JSON.stringify({
    action: 'fallback',
    email: ACCOUNT_EMAIL,
    tripId: FALLBACK_TRIP_ID,
    message: 'SELECT name FROM trips',
  }),
});

if (!res.ok) {
  throw new Error(
    'Could not plant a fallback reply for ' + ACCOUNT_EMAIL + ' on ' + FALLBACK_TRIP_ID + ' — HTTP ' +
      res.status + ': ' + res.body +
      '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
      'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
  );
}
