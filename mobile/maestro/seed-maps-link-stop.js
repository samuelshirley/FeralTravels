// Seed the canonical "August Portugal Trip" on ${EMAIL}'s account, then paste
// the real Google share link that failed on 2026-09-26 into Penny's add_stop
// path, server-side, for the Porto → Lisbon day.
//
// ── Why this goes through /api/test/maps-link-stop and not the chat ─────────
//
// In a real turn the server resolves the link BEFORE Penny sees the message
// (resolveMapsLinksInMessage), and Penny's only job is to copy the resolved
// lat/lng and name into add_stop. The endpoint runs every step of that path —
// the live link resolution, VALIDATORS.add_stop, applyAddStop — except the
// model, so this costs no Anthropic call and races nothing. What the APP then
// renders is real: it loads the trip from the API like any other.
//
// ── Why the link is fetched live ─────────────────────────────────────────
//
// Google's share-link behaviour is the thing that broke (a 3-hop redirect to
// an address-only q=, coords only in the og:image staticmap). A mocked page
// would prove the parser against what Google did once; this proves it against
// what Google does today. It is one free short-link expansion — zero paid
// Places calls on the current page.
//
// /api/test/* is fixture DATA: off on production with no override, locked by
// the per-run HMAC on a preview, and it refuses any address outside
// FIXTURE_EMAIL_PATTERN or a trip that address does not own.

var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var tripName = 'E2E Fixture August Portugal Trip';
// Matched without the arrow: this file's non-ASCII is not worth trusting to
// whatever charset the script engine reads it in.
function isPortoToLisbon(title) {
  return title.indexOf('Porto') === 0 && title.indexOf('Lisbon') > 0;
}
var shareLink = 'https://maps.app.goo.gl/ys3PKbHMPZbQq8o29?g_st=ic';

var seeded = http.post(BASE_URL + '/api/test/trip', {
  headers: headers,
  body: JSON.stringify({ email: EMAIL, name: tripName, kind: 'canonical' }),
});
if (!seeded.ok) {
  throw new Error(
    'Could not seed the canonical trip for ' + EMAIL + ' — HTTP ' + seeded.status + ': ' + seeded.body +
      '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
      'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
  );
}
var trip = JSON.parse(seeded.body);
var leg = null;
for (var i = 0; i < trip.legs.length; i++) {
  if (isPortoToLisbon(trip.legs[i].title)) leg = trip.legs[i];
}
if (!leg) {
  throw new Error('The seeded canonical trip has no Porto to Lisbon leg: ' + seeded.body);
}

var added = http.post(BASE_URL + '/api/test/maps-link-stop', {
  headers: headers,
  body: JSON.stringify({
    email: EMAIL,
    tripId: trip.tripId,
    legId: leg.id,
    message: 'Add this overnight location for my stop in Lisbon ' + shareLink,
    status: 'selected',
  }),
});
var result = {};
try {
  result = JSON.parse(added.body);
} catch (e) {
  result = {};
}
if (!added.ok) {
  var stage = result.link && result.link.stage ? result.link.stage : 'n/a';
  throw new Error(
    'The share link did not become a stop — HTTP ' + added.status + ', stage=' + stage + ': ' + added.body
  );
}
if (!/Pra.a do Com.rcio/.test(result.link.name || '')) {
  throw new Error('The link resolved to the wrong name: ' + added.body);
}
if (Math.abs(result.link.lat - 38.707) > 0.01 || Math.abs(result.link.lng - -9.1357) > 0.01) {
  throw new Error('The link resolved to the wrong place: ' + added.body);
}

output.tripName = tripName;
output.legId = leg.id;
