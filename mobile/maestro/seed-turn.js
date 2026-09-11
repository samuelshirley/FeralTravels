// Plant a `penny_turns` row for ${EMAIL}'s seeded trip, so the flow can open
// the chat screen while the server is "mid-answer".
//
// ── Why the turn is planted rather than run ───────────────────────────────
//
// Producing that state honestly means asking Penny to plan something and
// racing her: an Anthropic call on every CI run — which is the exact spend the
// `ai-tests` label exists to keep off a push — 60-90 seconds of wall clock, and
// a race the flow would start losing the day she got faster.
//
// Nothing about the APP is faked. It reads the real `GET /api/trips/[id]/turns`
// and decides for itself what to render, which is the decision that was broken:
// a chat screen mounted while a turn was running showed READY and no indicator.
//
// `/api/test/turn` is fixture DATA like the rest of /api/test/* — off on
// production with no override, locked by the per-run HMAC on a preview, and it
// refuses any address outside FIXTURE_EMAIL_PATTERN.

var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

// The trip the fixture seeded. TRIP_ID comes from scripts/ios-e2e-fixture.mjs,
// which read it off the seed response — so it cannot drift from the row that
// actually exists, the same argument TRIP_NAME travels under.
if (typeof TRIP_ID === 'undefined' || !TRIP_ID) {
  throw new Error('seed-turn.js needs TRIP_ID — the runner passes it with -e TRIP_ID=<uuid>.');
}
var tripId = TRIP_ID;

var res = http.post(BASE_URL + '/api/test/turn', {
  headers: headers,
  body: JSON.stringify({ action: 'seed', email: EMAIL, tripId: tripId, status: 'running' }),
});

if (!res.ok) {
  throw new Error(
    'Could not plant a turn for ' + EMAIL + ' on ' + tripId + ' — HTTP ' + res.status +
      '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
      'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
  );
}

output.turnKey = JSON.parse(res.body).idempotencyKey;
