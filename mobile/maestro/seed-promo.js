// Mint a promo code for a fixture account, through POST /api/test/promo — the
// guarded fixture route (404 off test deployments, the per-run secret, and a
// FIXTURE_EMAIL_PATTERN check in both the schema and the handler). It mints a
// CODE, not access: redeeming it is the flow's job, through the real sheet,
// the real route and a real OTP session.
//
// Parameters (from the calling flow's `env:`, all of them every call):
//   PROMO_EMAIL         the fixture address the code is bound to
//   PROMO_EXPIRES_DAYS  days until it expires; '' for no expiry
//
// Output: output.promo.code (raw) and output.promo.display (FERAL-XXXX-XXXX).
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var body = { email: PROMO_EMAIL };
if (PROMO_EXPIRES_DAYS) body.expiresInDays = parseInt(PROMO_EXPIRES_DAYS, 10);

var res = http.post(BASE_URL + '/api/test/promo', { headers: headers, body: JSON.stringify(body) });
if (!res.ok) {
  throw new Error(
    'POST /api/test/promo for ' + PROMO_EMAIL + ' — HTTP ' + res.status + ': ' + res.body +
      '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, the secret does not match, ' +
      'or the address is not a fixture address.'
  );
}
var minted = JSON.parse(res.body);
output.promo = { code: minted.code, display: minted.display };
