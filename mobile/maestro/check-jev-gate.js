// Prove, from the server's own ledger, what the message gate did with the
// flow's latest message, and that Jev was asked wherever the gate needed a
// model.
//
// ── Why the screen is not enough ───────────────────────────────────────────
//
// Penny answering proves the gate said T1, not who said it. Both older AI
// flows passed locally on a Jev-first account while Jev was never called: the
// free rules in lib/pennyGate.ts (trip names, trip vocabulary) settled every
// message before the classifier, so nothing reached Jev. A flow that only
// watched the screen would stay green with Jev switched off, unconfigured, or
// deleted. This reads the rows the gate writes for every message
// (`penny:gate`) and every Jev call (`jev`) through /api/test/turn's
// `gate-ledger` action: tiers, deciders and Jev's numbers, never user text.
//
// ── Two kinds of message ───────────────────────────────────────────────────
//
// REQUIRE_JEV '1' — a message the free rules cannot settle. It must reach the
// classifier, and JEV must settle it (T1, confident): this is the proof Jev is
// wired, configured and trusted. Haiku letting it through is not enough.
//
// REQUIRE_JEV '' — a bare reply to Penny ("yes do that", "undo that"). Since
// the gate's reply rule these are let through FREE straight after a Penny
// message, so they need not reach a model at all. They must be T1, by any
// decider. If one does reach the classifier anyway, it must have its own Jev
// row like every classifier-path message.
//
// Called after each message, so a failure names the message it is about and
// says who refused it: the decider, and Jev's choice, top probability and
// reason for deferring to Haiku.
//
// Parameters (the calling flow's `env:` block, all of them on every call):
//   ACCOUNT_EMAIL   the fixture account seed-account.js minted
//   MESSAGE_NO      '1', '2', … — how many messages the flow has sent so far
//   MESSAGE_LABEL   the message, for the failure text only (synthetic copy)
//   REQUIRE_JEV     '1' = Jev itself must settle this message; '' = any T1
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

// Every message that reached the classifier asked Jev once (Jev first), in
// order — so the Jev rows line up with the classifier-path gate rows.
var classifierPath = 0;
for (var i = 0; i < gate.length; i++) if (gate[i].by === 'classifier') classifierPath++;

if (REQUIRE_JEV === '1' && g.by !== 'classifier') {
  // The point of this message. One the free rules settle never reaches Jev.
  throw new Error(
    what + ' was decided ' + g.tier + ' by ' + g.by + ', not by the classifier, so Jev was never ' +
      'asked. The free rules in src/lib/pennyGate.ts (decideDeterministically) settled it: reword ' +
      'it so it names no trip place, uses no trip vocabulary and is not a bare reply.'
  );
}

if (g.by === 'classifier') {
  if (jev.length === 0) {
    throw new Error(
      what + ' reached the classifier, but there is NO Jev row for this account: Jev was never ' +
        'asked. users.jev_mode is not "on" for it (seed-account.js JEV_MODE), or the gate no ' +
        'longer calls Jev first (src/server/messageGate.ts).'
    );
  }
  if (jev.length !== classifierPath) {
    throw new Error(
      what + ': ' + classifierPath + ' message(s) reached the classifier but there are ' +
        jev.length + ' Jev row(s); every classifier-path message asks Jev exactly once.'
    );
  }
  var j = jev[jev.length - 1];
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
} else if (jev.length !== classifierPath) {
  throw new Error(
    what + ' was decided by ' + g.by + ' with no model, yet the account has ' + jev.length +
      ' Jev row(s) for ' + classifierPath + ' classifier-path message(s).'
  );
}

var jj = g.by === 'classifier' ? jev[jev.length - 1] : null;

if (g.tier !== 'T1') {
  throw new Error(
    what + ' was REFUSED: the gate said ' + g.tier + ' by ' +
      (g.by !== 'classifier' ? g.by : g.byJev ? 'Jev' : 'Haiku') +
      (jj ? '. ' + describeJev(jj) + '. Jev may only settle a confident T1 (JEV_T1_MIN, ' +
        'src/server/jev/decide.ts); anything else goes to Haiku, whose answer is final.' : '.')
  );
}

if (REQUIRE_JEV === '1' && !(g.byJev && jj && jj.settled === true)) {
  throw new Error(
    what + ' was let through by Haiku, not settled by Jev: ' + describeJev(jj) + '. This message ' +
      'is the flow\'s proof that Jev decides; JEV_T1_MIN is 0.85 (src/server/jev/decide.ts).'
  );
}

output.jevGate = {
  message: n,
  tier: g.tier,
  by: g.by,
  byJev: g.byJev,
  choice: jj ? jj.choice : null,
  top: jj ? jj.top : null,
  settled: jj ? jj.settled : null,
  deferredReason: jj ? jj.deferredReason : null,
};
console.log(
  what + ': ' + g.tier + ' by ' + (g.by !== 'classifier' ? g.by : g.byJev ? 'Jev' : 'Haiku') +
    (jj ? '; ' + describeJev(jj) : '')
);
