// Put a fixture account into a subscription state over /api/test/subscription.
//
// AFTER SIGN-IN, ALWAYS. Every `playwright-*@e2e.feraltravels.com` address is
// comped (src/server/payments/comped.ts), and native OTP sign-in re-sets
// `users.comped` from the address — so a `comped: false` written before the
// sign-in is silently undone by it, in the direction that makes every paywall
// assertion vacuous. e2e/subscriptions.spec.ts carries the same warning.
//
// Parameters (the calling flow's `env:` block, all of them every time):
//   ACCOUNT_EMAIL        the fixture address to change
//   COMPED               '1' | '0'
//   CREATED_DAYS_AGO     trial age in days, as digits ('7' = trial over)
//   SUBSCRIPTION_STATUS  '' | 'active' | 'expired' | … — '' writes no row
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var body = {
  email: ACCOUNT_EMAIL,
  comped: COMPED === '1',
  createdAtDaysAgo: parseInt(CREATED_DAYS_AGO, 10),
  anthropicSpendUsd: 0,
};
if (SUBSCRIPTION_STATUS) {
  body.subscription = {
    status: SUBSCRIPTION_STATUS,
    source: 'fake',
    autoRenew: true,
    currentPeriodEndDaysFromNow: 30,
  };
}

var res = http.post(BASE_URL + '/api/test/subscription', {
  headers: headers,
  body: JSON.stringify(body),
});
if (!res.ok) {
  throw new Error('POST /api/test/subscription for ' + ACCOUNT_EMAIL + ' — HTTP ' + res.status + ': ' + res.body);
}
