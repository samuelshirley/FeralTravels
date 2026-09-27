// Seed rest-day-stop.yaml's state: the canonical trip, plus the Lisbon share
// link as a stop on its LAST Lisbon base day — the lowest base day in the list,
// which is the case #70's note box had to scroll above the keyboard for.
//
// Same two endpoints as seed-maps-link-stop.js, and the same live link — that
// flow puts it on the Porto → Lisbon DRIVE day, this one on a BASE day, which
// is the #67 case: the stop was saved and mapped but no itinerary listed it.
// A differently named trip, because both flows run in the `trips` shard on the
// same account and the trips list must tell them apart.
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var tripName = 'E2E Fixture Base Day Trip';
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
  var l = trip.legs[i];
  if (l.title.indexOf('Lisbon') === 0 && l.title.indexOf('rest day') > 0) {
    if (!leg || l.sortOrder > leg.sortOrder) leg = l;
  }
}
if (!leg) {
  throw new Error('The seeded canonical trip has no "Lisbon (rest day)" leg: ' + seeded.body);
}

// Google's short-link host answers HTTP 429 when the runner resolved the same
// link seconds earlier (maps-link-stop.yaml runs just before this in the
// `trips` shard; CI run 36317917362). Only that stage is retried, with a wait:
// Maestro's JS has no timers, so the wait is a clock-bounded loop.
function addStop() {
  return http.post(BASE_URL + '/api/test/maps-link-stop', {
    headers: headers,
    body: JSON.stringify({
      email: EMAIL,
      tripId: trip.tripId,
      legId: leg.id,
      message: 'Add this overnight location for my stop in Lisbon ' + shareLink,
      status: 'selected',
    }),
  });
}
function stageOf(res) {
  try {
    var b = JSON.parse(res.body);
    return b.link && b.link.stage ? b.link.stage : null;
  } catch (e) {
    return null;
  }
}
var added = addStop();
for (var attempt = 1; attempt <= 2 && !added.ok && stageOf(added) === 'http_429'; attempt++) {
  var until = Date.now() + attempt * 15000;
  while (Date.now() < until) {}
  added = addStop();
}
var result = {};
try {
  result = JSON.parse(added.body);
} catch (e) {
  result = {};
}
if (!added.ok) {
  var stage = result.link && result.link.stage ? result.link.stage : 'n/a';
  throw new Error(
    'The share link did not become a stop on the base day — HTTP ' + added.status + ', stage=' + stage + ': ' + added.body
  );
}

output.tripName = tripName;
output.legId = leg.id;
