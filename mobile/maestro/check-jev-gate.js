// Prove, from the server's own ledger, that the message gate ASKED JEV about
// message ${MESSAGE_NO} and let it through to Penny.
//
// ── Why the screen is not enough ───────────────────────────────────────────
//
// Penny answering proves the gate said T1, not who said it. Both existing AI
// flows passed locally on a Jev-first account while Jev was never called: the
// free rules in lib/pennyGate.ts (trip names, trip vocabulary) settled every
// message before the classifier, so nothing reached Jev. A flow that only
// watched the screen would stay green with Jev switched off, unconfigured, or
// deleted. This reads the rows the gate writes for every message
// (`penny:gate`) and every Jev call (`jev`) through /api/test/turn's
// `gate-ledger` action: tiers, deciders and Jev's numbers, never user text.
//
// Called after each message, so a failure names the message it is about, and
// says who refused it: the gate row's decider, and Jev's choice, top
// probability and reason for deferring to Haiku.
//
// Parameters (the calling flow's `env:` block, all of them on every call):
//   ACCOUNT_EMAIL   the fixture account seed-account.js minted
//   MESSAGE_NO      '1', '2', … — how many messages the flow has sent so far
//   MESSAGE_LABEL   the message, for the failure text only (synthetic copy)
//   EXPECT_SETTLED  '1' on the last call: at least one message must have been
//                   settled by Jev itself, or Jev decided nothing in this run
var headers = { 'content-type': 'application/json' };
if (typeof TEST_SECRET !== 'undefined' && TEST_SECRET) {
  headers['x-e2e-test-secret'] = TEST_SECRET;
}

var res = http.post(BASE_URL + '/api/test/turn', {
  headers: headers,
  body: JSON.stringify({ action: 'gate-ledger', email: ACCOUNT_EMAIL }),
});
if (!res.ok) {
  throw new Error(
    'Could not read the gate ledger for ' + ACCOUNT_EMAIL + ' — HTTP ' + res.status + ': ' + res.body +
      '. A 404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or ' +
      'x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.'
  );
}
var ledger = JSON.parse(res.body);
var gate = ledger.gate;
var jev = ledger.jev;
var n = parseInt(MESSAGE_NO, 10);
var what = 'Message ' + n + ' ("' + MESSAGE_LABEL + '")';

function describeJev(j) {
  if (!j) return 'no Jev row';
  return (
    'Jev ' + (j.choice || 'gave no answer') +
    ' top=' + j.top +
    ' settled=' + j.settled +
    ' deferredReason=' + j.deferredReason +
    ' success=' + j.success
  );
}

if (gate.length !== n) {
  throw new Error(
    what + ': expected ' + n + ' gate decision(s) for this account, found ' + gate.length +
      '. Either the message never reached the gate (did the send land?) or the account sent ' +
      'something this flow did not.'
  );
}
var g = gate[n - 1];

// The point of the flow. A message the free rules settle never reaches Jev,
// and passing it would prove nothing about Jev.
if (g.by !== 'classifier') {
  throw new Error(
    what + ' was decided ' + g.tier + ' by ' + g.by + ', not by the classifier, so Jev was never ' +
      'asked. The free rules in src/lib/pennyGate.ts (decideDeterministically) settled it: reword ' +
      'it so it names no trip place and uses no trip vocabulary.'
  );
}

if (jev.length === 0) {
  throw new Error(
    what + ' reached the classifier, but there is NO Jev row for this account: Jev was never asked. ' +
      'users.jev_mode is not "on" for it (seed-account.js JEV_MODE), or the gate no longer calls ' +
      'Jev first (src/server/messageGate.ts).'
  );
}
if (jev.length !== n) {
  throw new Error(
    what + ': expected one Jev call per message, ' + n + ' in all, found ' + jev.length + '.'
  );
}
var j = jev[n - 1];
if (!j.success) {
  if (j.deferredReason === 'not_configured') {
    throw new Error(
      what + ': Jev is NOT CONFIGURED on this preview. JEV_BASE_URL, JEV_API_KEY and JEV_MODEL ' +
        'come from the Vercel project\'s Preview environment; one is missing or rejected ' +
        '(src/server/jev/config.ts; /admin shows the reason).'
    );
  }
  throw new Error(
    what + ': the Jev call failed (' + describeJev(j) + '), so Haiku decided alone. ' +
      'A timeout is JEV_TIMEOUT_MS; http_401 is the key.'
  );
}

if (g.tier !== 'T1') {
  throw new Error(
    what + ' was REFUSED: the gate said ' + g.tier + ' by ' + (g.byJev ? 'Jev' : 'Haiku') +
      '. ' + describeJev(j) + '. Jev may only settle a confident T1 (JEV_T1_MIN, ' +
      'src/server/jev/decide.ts); anything else goes to Haiku, whose answer is final.'
  );
}

if (EXPECT_SETTLED === '1') {
  var settled = 0;
  for (var i = 0; i < jev.length; i++) if (jev[i].settled === true) settled++;
  if (settled === 0) {
    var all = [];
    for (var k = 0; k < jev.length; k++) all.push('#' + (k + 1) + ' ' + describeJev(jev[k]));
    throw new Error(
      'Jev settled none of the ' + jev.length + ' messages: Haiku decided every one. ' + all.join('; ')
    );
  }
}

output.jevGate = {
  message: n,
  tier: g.tier,
  byJev: g.byJev,
  choice: j.choice,
  top: j.top,
  settled: j.settled,
  deferredReason: j.deferredReason,
};
console.log(what + ': ' + g.tier + ' by ' + (g.byJev ? 'Jev' : 'Haiku') + '; ' + describeJev(j));
