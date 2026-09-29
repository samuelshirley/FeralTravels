# Jev — a cheap first opinion for the message gate

> Added 2026-09-29. The switch ships **OFF**, and with it off nothing in this
> file runs: no network call, no new row, Haiku exactly as before.

## What Jev is

Jev is a **typed-decision model**. You ask it a question with a fixed answer
type (a `choice`, a score, a yes/no) and it answers with a label **plus a
probability per label**, rather than prose. TypeSafe's hosted Jev is
waitlist-only. Here it runs as an **open-source, Jev-compatible server on Sam's
own GPU box**. The first one tried is Laya typed-decisions (421M params,
Apache-2.0), and any server that speaks the same wire API will do.

The aim is **cost**. Every message the deterministic rules in `lib/pennyGate.ts`
cannot settle costs one Haiku classifier call (~$0.0013, decision I11). A
self-hosted GPU is a fixed cost, so each message Jev settles is one Haiku call
not made.

## The wire API (System One)

```
POST {JEV_BASE_URL}/v1/systemone
Authorization: Bearer {JEV_API_KEY}        # optional off-production
{"model": JEV_MODEL, "state": "<text>",
 "questions": {"tier": {"type": "choice", "instructions": "<text>",
                        "criteria": {"T1": "...", "T2": "...", "T3": "..."}}}}

200 → {"model": "...", "answers": {"tier": {"type": "choice", "choice": "T1",
        "probabilities": {"T1": 0.9, "T2": 0.07, "T3": 0.03},
        "confidence": ..., ...extra}}, "usage": {"input_tokens": n, "output_tokens": n}}
errors: 401, 422, 429, 529
```

The question is built from **the same source as Haiku's**
(`src/server/jev/question.ts`): `instructions` is `CLASSIFY_SYSTEM`, `state` is
`buildClassifyContent()`, and the three `criteria` are cut out of the classifier
tool's own `tier` description. The two classifiers cannot drift apart, and
`jevAdapter.test.ts` fails if the `T1 = … T2 = … T3 =` layout they are cut from
changes shape.

## The flag: three modes

| Mode | Value | What the gate does |
|---|---|---|
| **HAIKU ONLY** | `'off'` | Haiku, as before Jev existed. No network call to Jev. |
| **COMPARE** | `'compare'` | Haiku decides every message, exactly as `'off'`. Jev is asked the same question **at the same moment**, and its answer is only **logged** beside Haiku's (below). |
| **JEV FIRST** | `'on'` | Jev first. It may settle a confident T1 and nothing else; everything else goes to Haiku. |

| Where | Values | Meaning |
|---|---|---|
| `app_meta.jev_mode` (global) | `'off'` / `'compare'` / `'on'` | The mode for every account without an override. **Missing row, a read error, or any other value = OFF.** 30 s cache, like the paywall switch. |
| `users.jev_mode` (per account) | `null` / `'off'` / `'compare'` / `'on'` | `null` follows the global; any mode forces that mode for this account. Anything else = `null`. |

Both columns are plain text, with no CHECK constraint, so the third mode needed
no migration. Effective mode = the account's override if set, else the global
row. Both are flipped from /admin: the global three-way switch sits under the
Penny lockdown block, and the per-account control is on `/admin/users/[id]`, in
four states (follow global / Haiku only / Compare / Jev first). Each flip writes
an `admin:jev-*` `usage_events` row naming who pressed it. Every read and write
goes through `src/server/repos/jev.ts`.

## Compare: measuring Jev-first before trusting it

Compare exists to answer one question with real traffic: **would Jev-first be
safe?** It asks it without changing a single outcome.

- For every message the deterministic rules don't settle, the gate **starts
  Jev and Haiku together** (`startJevClassifyTier`, then `classifyMessage`).
- **Haiku's verdict decides**: the same tier, reason, strike and `penny:gate`
  row as mode off. Jev's answer cannot change the tier, the strike, the reason,
  or whether Haiku is called (`haikuComparedWithJev` in `messageGate.ts`).
- Once Haiku has answered, the gate waits for Jev **at most until Jev's own
  timeout (`JEV_TIMEOUT_MS`), counted from when Jev was started**. So compare
  adds whatever of that timeout is left after Haiku, and usually nothing. The
  deadline bounds the wait even if a backend ignores the abort.
- A Jev error or timeout is one `success: false` row and changes nothing else.

Each compared message writes one `provider: 'jev'` row, whose `meta` is:

```
{mode: 'compare', source: 'global'|'user', choice, top, margin, latencyMs,
 settled: false, wouldSettle, haikuTier, agree, deferredReason, echoedModel}
```

`wouldSettle` = the Jev-first rule (`settlesAsT1`) would have let this message
through without Haiku. `agree` = Jev's `choice === haikuTier`, false when Jev
gave no answer. `settled` is always false, because in compare Jev settles
nothing. As with every Jev row: no user text, $0, and counted toward no cap.

/admin's compare section reads only these rows (the Jev-first stats exclude
them):

- **The headline: "Jev would have passed, Haiku refused"**, the rows with
  `wouldSettle` true and Haiku's tier not T1, as a count and as a rate out of
  every `wouldSettle` row, split T2/T3. Each one is a message Jev-first would
  have handed to Penny that Haiku kept from her. **This is the number that says
  whether Jev-first is safe**, and the one to read before turning it on.
- **Coverage**: of Haiku's T1s, the share Jev-first would have settled. That is
  how many Haiku calls Jev-first would save.
- The number compared, Jev's errors and timeouts, overall agreement (out of the
  messages Jev answered), Jev's p50/p95 latency, and a 3×3 table of Haiku's tier
  (rows) × Jev's choice (columns).

Use it to set `JEV_T1_MIN` for a new backend. Run compare, raise the threshold
until the headline is at or near zero, then read what coverage is left.

## The rule: Jev may settle a T1 and nothing else

When the mode is on and Jev is configured, the gate asks Jev first. **Jev's
answer stands only if it is `T1` with top probability ≥ `JEV_T1_MIN` (default
0.85) AND top minus second ≥ 0.2** (`src/server/jev/decide.ts`). Every other
outcome calls the unchanged `classifyMessage` (Haiku), and **Haiku's answer is
final**:

- T2 or T3, however confident
- a T1 below the threshold, or with a narrow lead
- HTTP 401 / 422 / 429 / 529 / anything non-2xx
- a timeout (`JEV_TIMEOUT_MS`, default 800 ms), a network error, bad JSON
- a schema failure: not a `choice`, a label outside T1/T2/T3, or a choice that
  is not the most probable label
- no config, or a rejected one
- anything that throws

**Why only T1.** The two mistakes are not the same size. A wrong T1 costs one
planning turn that Penny may answer with "I can't help with that", and it is
the answer the gate already fails open to on every error path (decision I14). A
wrong T3 refuses a real driver and puts a strike on their account, and three
strikes pause Penny for an hour (I9). **Nothing in this app may strike a driver
on Jev's word.** Jev reaches the strike logic only through the final tier,
and it can only make that tier T1.

`GateDecision` (`lib/pennyGate.ts`, mirrored to mobile) is unchanged. A message
Jev settles is recorded `by: 'classifier'` with reason `jev T1 p=0.93`, and the
Jev call gets its own row (below).

## Accounting

One `usage_events` row per Jev call: `provider: 'jev'`, `cost_microcents: 0`,
tokens, `success`, and `meta` (jsonb, migration 0043). A Jev-first row:

```
{mode: 'global'|'user', choice, top, margin, latencyMs, settled, deferredReason, echoedModel}
```

A compare row has `mode: 'compare'` and the keys in **Compare** above.

**Never user text.** `meta` is built key by key from the outcome, never spread.
Error strings never include a response body, and an echoed `model` that does
not look like a model id is dropped (`messageGateJev.test.ts` feeds it a backend
that echoes the message back in every field).

**`jev` rows count toward nothing.** Not the 120/hour request limit or daily $
cap (`getUserUsageSummary` excludes them by name). Not the 12-month cap, the
trial ceiling or the spend breakers, which count `anthropic%` only. They are $0,
and a Jev call is bookkeeping for a message the gate already counts once.

For Jev first, /admin shows the last 7 days: settled, passed to Haiku, errors and timeouts,
p50/p95 latency, and **Haiku dollars avoided** = settled × the average Haiku
classifier call. That average comes from 30 days of `usage_events`, and the
classifier's rows share Penny's model id, so they are picked out by shape:
`CLASSIFY_MODEL`, output ≤ `CLASSIFY_MAX_TOKENS`, input ≤ 1500, no cache
tokens. The onboarding helpers share that shape and are rare. With no rows it
falls back to I11's measured $0.001352 and says so.

## Config, and the local-host guard

Server environment only (`src/server/jev/config.ts`), **never from a request,
never under `NEXT_PUBLIC_*`**:

| Var | Default | Notes |
|---|---|---|
| `JEV_BASE_URL` | — | Required. http(s), no credentials, no query. |
| `JEV_API_KEY` | — | Sent as a bearer token. **Required in production.** |
| `JEV_MODEL` | `typed-decisions` | The id the server answers to. |
| `JEV_TIMEOUT_MS` | 800 | 1–5000. The whole exchange, body included. |
| `JEV_T1_MIN` | 0.85 | 0.5–1. **Re-measure per backend** (below). |

- A **localhost / loopback / private-range / `.local` host is accepted only
  when `VERCEL_ENV` and `CI` are both unset**, i.e. on a laptop. On Vercel
  such a URL names something inside Vercel's network, and in CI it names the
  runner. `new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and
  both spellings are refused (`jevConfigGuard.test.ts` found this).
- When **`VERCEL_ENV === 'production'` the URL must be https and a key is
  required**, because the body is a driver's message.
- A rejected or missing config is "not configured". **It never throws.** The
  gate goes to Haiku, and /admin shows the reason next to the switch.
- No workflow sets `JEV_*`: CI must never call Jev, and the unit tests mock
  `fetch`.

The default model id lives in `config.ts`, not `src/lib/models.ts`. That file is
the Anthropic registry and is mirrored into `mobile/shared/`, and a change there
publishes an OTA update.

## Open-source backends are uncalibrated

**Never trust a backend's `confidence` field.** On Laya it read 0.03–0.17 even
on answers that were right. Its captured response is the fixture in
`jevAdapter.test.ts`: `confidence: 0.1473` on an answer whose own top
probability is 0.5976. The gate reads only `probabilities`, as the top one and
top minus second, and ignores every extra field.

Even `probabilities` is a backend's own scale. **`JEV_T1_MIN` must be
re-measured for each backend and each model version** before the global switch
goes on. Run compare (or a labelled set) through it, pick the threshold where
Jev's would-settle T1s are all Haiku T1s, and only then switch to Jev first. The local CPU trial found Laya
right on clear messages and unable to flag unclear ones, which is exactly the
case the threshold exists for.

## Privacy

Once the switch is on (Jev first **or compare**) for real users, **the GPU host is a processor of chat
messages** (the classifier-path ones, with the trip's name and place names). The
privacy page (`src/app/(legal)/privacy`) lists every sub-processor and **must
name the Jev host before the global switch is turned on with real users.**
Production has no real users yet (CLAUDE.md), so trying it per-account on test
accounts is fine today.

## Where it lives

- `src/server/jev/`: a **bounded module**. `index.ts` (`jevClassifyTier`,
  `jevConfigStatus`) is the only public surface, and `jevBoundaryGuard.test.ts`
  allows only `messageGate.ts`, `repos/jev.ts`, `api/admin/jev/**` and
  `scripts/` to import it. Penny (`claude.ts`) and the replan route must not.
- `src/server/repos/jev.ts`: the switches, the ledger rows, the /admin stats.
- `src/server/messageGate.ts`: `jevSettles()` (Jev first) and
  `haikuComparedWithJev()` (compare), called only when the free deciders
  returned nothing.
- `api/admin/jev` and `api/admin/jev/user`: cookie-only admin, Zod, logged.
- Tests: `jevAdapter.test.ts`, `messageGateJev.test.ts`, `jevConfigGuard.test.ts`,
  `jevBoundaryGuard.test.ts`, `JevSwitch.test.tsx`. Decisions I20–I22.
