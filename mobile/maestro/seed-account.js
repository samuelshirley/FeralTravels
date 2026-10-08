// A FRESH fixture account for one flow.
//
// WHY A SECOND ACCOUNT. Every flow in a shard shares the account the job minted
// (EMAIL), and /api/test/seed RESETS the account it is given — trips, vehicles
// and units preference. A flow that needs a state of its own (a forced fuel
// stop, an expired trial, an account it is about to delete) would wipe the
// trips the other flows in its shard are using. So it gets its own address,
// derived from the shard's by a suffix: still `playwright-…@e2e.feraltravels.com`
// (FIXTURE_EMAIL_PATTERN), still unique per run, and it cannot collide with a
// sibling flow as long as the suffixes differ.
//
// Every parameter is passed by the calling flow's `env:` block, ALL of them on
// every call (an empty string means "no"), so maestroFlowParams.test.ts can
// see each one supplied rather than trusting a `typeof` default:
//   ACCOUNT_SUFFIX    e.g. 'fs' → playwright-…-fs@e2e.feraltravels.com
//   SEED_CANONICAL    '1' → /api/test/seed: the default vehicle and the
//                     two-leg Paris → Strasbourg → Stuttgart trip
//                     ('E2E Fixture Trip'), with the chat that planned it
//                     (seededTranscript.ts). '' → the account owns nothing yet.
//   FORCED_FUEL_STOP  '1' → a forced Finn stop on day 1 of that trip, its fuel
//                     cache stamped fresh so no Places search runs
//   RANGE_KM          the seeded vehicle's range in km, '' for the Hilux's 500
//   JEV_MODE          '' | 'on' | 'compare' | 'off' — force the account's
//                     message-gate Jev mode (users.jev_mode); needs
//                     SEED_CANONICAL. Only penny-jev-gate.yaml sets it.
//   EXTRA_TRIP_KIND   '' | 'blank' | 'onboarding' | 'vehicle_new' — one more
//                     trip over /api/test/trip (see createAdHocTrip)
//   EXTRA_TRIP_NAME   its name
//
// Outputs (output.account.*): email, tripName (the trip the trips list is
// guaranteed to show — the extra one when there is one), tripId.
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

function post(path, body) {
  var res = http.post(BASE_URL + path, { headers: headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(
      'POST ' + path + ' for ' + body.email + ' — HTTP ' + res.status + ': ' + res.body +
        '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
        'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
    );
  }
  return JSON.parse(res.body);
}

if (!/^[a-z0-9]+$/.test(ACCOUNT_SUFFIX)) {
  throw new Error('seed-account.js needs ACCOUNT_SUFFIX (lowercase letters/digits), got "' + ACCOUNT_SUFFIX + '"');
}
var at = EMAIL.indexOf('@');
var email = EMAIL.slice(0, at) + '-' + ACCOUNT_SUFFIX + EMAIL.slice(at);

if (JEV_MODE && SEED_CANONICAL !== '1') {
  throw new Error('seed-account.js: JEV_MODE is set by /api/test/seed, so it needs SEED_CANONICAL=1');
}

var tripName = null;
var tripId = null;

if (SEED_CANONICAL === '1') {
  var body = {
    email: email,
    userName: 'E2E Fixture User',
    vehicleName: 'E2E Fixture Van',
    tripName: 'E2E Fixture Trip',
  };
  if (FORCED_FUEL_STOP === '1') body.forcedFuelStop = true;
  if (RANGE_KM) body.rangeKm = parseInt(RANGE_KM, 10);
  if (JEV_MODE) body.jevMode = JEV_MODE;
  tripId = post('/api/test/seed', body).tripId;
  tripName = body.tripName;
}

if (EXTRA_TRIP_KIND) {
  if (!EXTRA_TRIP_NAME) throw new Error('seed-account.js: EXTRA_TRIP_KIND needs EXTRA_TRIP_NAME');
  tripId = post('/api/test/trip', { email: email, name: EXTRA_TRIP_NAME, kind: EXTRA_TRIP_KIND }).tripId;
  tripName = EXTRA_TRIP_NAME;
}

if (!tripName) {
  // sign-in.yaml ends by waiting for a trip card, so an account with no trip
  // would fail there with a message about the trips list rather than about this.
  throw new Error('seed-account.js: seed the canonical trip or an extra trip — the account would own nothing');
}

output.account = { email: email, tripName: tripName, tripId: tripId };
