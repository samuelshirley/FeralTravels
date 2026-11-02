// Seed feature-requests.yaml's rows: one In progress with a reply, one Open,
// one Not doing with its reason. Feature requests are GLOBAL — every flow and
// every Playwright spec on this preview sees every row — so the titles and
// replies carry a run tag, and the flow addresses only these ids.
//
// Outputs (output.fr.*): working, open, closed (ids), tag (the run tag).
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var tag = 'fr' + Date.now().toString(36);

function seed(body) {
  var res = http.post(BASE_URL + '/api/test/feature-request', {
    headers: headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      'Could not seed a feature request — HTTP ' + res.status + ': ' + res.body +
        '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
        'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
    );
  }
  return JSON.parse(res.body).id;
}

output.fr = {
  tag: tag,
  working: seed({
    title: 'E2E ' + tag + ' working',
    body: 'Seeded in progress, with a reply.',
    status: 'in_progress',
    reply: 'Reply ' + tag + ' working',
  }),
  open: seed({ title: 'E2E ' + tag + ' open', body: 'Seeded open, no votes.' }),
  closed: seed({
    title: 'E2E ' + tag + ' closed',
    status: 'not_doing',
    reply: 'Reason ' + tag + ' closed',
  }),
};
