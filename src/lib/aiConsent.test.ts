import { describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_COPY,
  AI_CONSENT_VERSION,
  TYPESAFE_CONSENT_VERSION,
  consentVersionFromMe,
  createAiConsentController,
  statusForVersion,
  type AiConsentSnapshot,
} from './aiConsent';
import { buildClassifyContent, PREVIOUS_ASSISTANT_MAX_CHARS } from './pennyClassifierPrompt';

/**
 * The consent sheet's logic, exactly as both panels run it (the phone through
 * mobile/shared/lib/aiConsent.ts, a byte-for-byte mirror). What it must hold:
 * nothing waiting on the sheet goes ahead until the agreement is STORED;
 * "Not now" refuses and is remembered for the screen; a failed save is shown,
 * never swallowed; an account that already agreed is never asked.
 */

/** `true` = agreed to the current sheet, `false` = never agreed, a number = that version. */
function make(opts: { consented?: boolean | number | 'throws'; save?: 'ok' | 'throws' } = {}) {
  const snapshots: AiConsentSnapshot[] = [];
  const fetchConsent = vi.fn(async (): Promise<number | null> => {
    if (opts.consented === 'throws') throw new Error('offline');
    if (opts.consented === true) return AI_CONSENT_VERSION;
    if (opts.consented === false || opts.consented === undefined) return null;
    return opts.consented;
  });
  const saveConsent = vi.fn(async () => {
    if (opts.save === 'throws') throw new Error('offline');
  });
  const c = createAiConsentController({ fetchConsent, saveConsent, onChange: (s) => snapshots.push(s) });
  return { c, fetchConsent, saveConsent, snapshots };
}

/** Let pending promise callbacks run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createAiConsentController', () => {
  it('an account that already agreed is never shown the sheet', async () => {
    const { c } = make({ consented: true });
    await c.load();
    expect(c.get().status).toBe('granted');
    expect(await c.ensure()).toBe(true);
    expect(c.get().sheetOpen).toBe(false);
  });

  it('ensure() before load() asks the server itself, and skips the sheet when agreed', async () => {
    const { c, fetchConsent } = make({ consented: true });
    expect(await c.ensure()).toBe(true);
    expect(fetchConsent).toHaveBeenCalledTimes(1);
    expect(c.get().sheetOpen).toBe(false);
  });

  it('a new account: the send waits on the sheet, and goes ahead only after the agreement is stored', async () => {
    const { c, saveConsent } = make({ consented: false });
    await c.load();
    expect(c.get().status).toBe('needed');

    let result: boolean | undefined;
    void c.ensure().then((r) => (result = r));
    await tick();
    expect(c.get().sheetOpen).toBe(true);
    expect(result).toBeUndefined(); // nothing sent yet

    await c.agree();
    await tick();
    expect(saveConsent).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    expect(c.get()).toMatchObject({ status: 'granted', sheetOpen: false, error: null });
    // ...and never again.
    expect(await c.ensure()).toBe(true);
    expect(saveConsent).toHaveBeenCalledTimes(1);
  });

  it('Not now: the waiting send is refused, the screen remembers it, and Review reopens the sheet', async () => {
    const { c, saveConsent } = make({ consented: false });
    await c.load();
    const pending = c.ensure();
    await tick();
    c.notNow();
    expect(await pending).toBe(false);
    expect(c.get()).toMatchObject({ status: 'declined', sheetOpen: false });
    expect(saveConsent).not.toHaveBeenCalled();

    c.open();
    expect(c.get().sheetOpen).toBe(true);
    await c.agree();
    expect(c.get().status).toBe('granted');
  });

  it('a failed save is shown in the sheet, keeps it open, and holds the send', async () => {
    const { c } = make({ consented: false, save: 'throws' });
    await c.load();
    let result: boolean | undefined;
    void c.ensure().then((r) => (result = r));
    await tick();
    await c.agree();
    await tick();
    expect(c.get()).toMatchObject({ sheetOpen: true, saving: false, error: AI_CONSENT_COPY.saveFailed });
    expect(c.get().status).not.toBe('granted');
    expect(result).toBeUndefined();
  });

  it('when /api/me cannot answer, the sheet asks rather than assuming either way', async () => {
    const { c } = make({ consented: 'throws' });
    await c.load();
    expect(c.get().status).toBe('unknown');
    void c.ensure();
    await tick();
    expect(c.get().sheetOpen).toBe(true);
  });

  it("a server 403 ai_consent_required puts the screen back to asking", async () => {
    const { c } = make({ consented: true });
    await c.load();
    c.requiredByServer();
    expect(c.get()).toMatchObject({ status: 'declined', sheetOpen: true });
  });

  it('every waiting caller is answered once', async () => {
    const { c } = make({ consented: false });
    await c.load();
    const a = c.ensure();
    const b = c.ensure();
    await tick();
    await c.agree();
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });
});

describe('an account that agreed to the older, Anthropic-only sheet (version 1)', () => {
  it('loads as `upgrade`, not `needed`: Penny is not switched off for it', async () => {
    const { c } = make({ consented: 1 });
    await c.load();
    expect(c.get().status).toBe('upgrade');
  });

  it('is shown the current sheet at its next send, and Agree stores it and sends', async () => {
    const { c, saveConsent } = make({ consented: 1 });
    await c.load();
    let result: boolean | undefined;
    void c.ensure().then((r) => (result = r));
    await tick();
    expect(c.get().sheetOpen).toBe(true);
    expect(result).toBeUndefined();
    await c.agree();
    await tick();
    expect(saveConsent).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    expect(c.get()).toMatchObject({ status: 'granted', sheetOpen: false });
  });

  it('"Anthropic only" lets the send go ahead, stores nothing, and does not ask again on this screen', async () => {
    const { c, saveConsent } = make({ consented: 1 });
    const pending = c.ensure();
    await tick();
    expect(c.get().sheetOpen).toBe(true);
    c.notNow();
    expect(await pending).toBe(true);
    expect(saveConsent).not.toHaveBeenCalled();
    // Still `upgrade` — not `declined`, so the composer stays enabled — and the
    // next send on this screen is not held by the sheet again.
    expect(c.get()).toMatchObject({ status: 'upgrade', sheetOpen: false });
    expect(await c.ensure()).toBe(true);
    expect(c.get().sheetOpen).toBe(false);
  });

  it('a new screen (a new controller) asks once more: "re-asked on the next chat"', async () => {
    const first = make({ consented: 1 });
    void first.c.ensure();
    await tick();
    first.c.notNow();
    const second = make({ consented: 1 });
    void second.c.ensure();
    await tick();
    expect(second.c.get().sheetOpen).toBe(true);
  });
});

describe('versions', () => {
  it('maps a stored version to a status', () => {
    expect(statusForVersion(null)).toBe('needed');
    expect(statusForVersion(0)).toBe('needed');
    expect(statusForVersion(1)).toBe('upgrade');
    expect(statusForVersion(AI_CONSENT_VERSION)).toBe('granted');
    expect(statusForVersion(AI_CONSENT_VERSION + 1)).toBe('granted');
  });

  it('reads /api/me from a versioned server and from one that predates versions', () => {
    expect(consentVersionFromMe({ ai_consent: true, ai_consent_version: 2 })).toBe(2);
    expect(consentVersionFromMe({ ai_consent: true, ai_consent_version: 1 })).toBe(1);
    // An older server: `ai_consent: true` alone can only mean the sheet it knew.
    expect(consentVersionFromMe({ ai_consent: true })).toBe(1);
    expect(consentVersionFromMe({ ai_consent: false, ai_consent_version: null })).toBeNull();
    expect(consentVersionFromMe({})).toBeNull();
  });

  it('the current sheet is the one that names TypeSafe', () => {
    expect(AI_CONSENT_VERSION).toBeGreaterThanOrEqual(TYPESAFE_CONSENT_VERSION);
  });
});

describe('the consent copy', () => {
  it('names both companies, the model and every kind of data that goes to Anthropic', () => {
    expect(AI_CONSENT_COPY.title).toBe('Penny uses Anthropic and TypeSafe');
    for (const word of ['messages', 'photos', 'trip details', 'location', 'Anthropic', 'Claude']) {
      expect(AI_CONSENT_COPY.body).toContain(word);
    }
    expect(AI_CONSENT_COPY.agree).toBe('Agree');
    expect(AI_CONSENT_COPY.notNow).toBe('Not now');
    expect(AI_CONSENT_COPY.notNowUpgrade).toBe('Anthropic only');
  });

  it('says what TypeSafe gets, where, and its training line only as TypeSafe states it', () => {
    const t = AI_CONSENT_COPY.typeSafeBody;
    expect(t).toContain('TypeSafe');
    expect(t).toContain('in the US');
    expect(t).toContain('TypeSafe says it doesn\'t train');
    // Exactly what buildClassifyContent + tripVocabulary send: the message, the
    // trip's name, the place and vehicle names on it, and the end of Penny's
    // previous message.
    for (const part of ['the text of each', "your trip's name", 'place and vehicle names', "the end of Penny's last reply"]) {
      expect(t).toContain(part);
    }
    // And nothing it does not send.
    for (const not of ['photo', 'location', 'date', 'distance', 'email']) {
      expect(t.toLowerCase()).not.toContain(not);
    }
  });

  it("is pinned to what buildClassifyContent actually sends — a new field fails here first", () => {
    const sent = buildClassifyContent('MESSAGE', {
      tripName: 'TRIPNAME',
      places: ['PLACE_A', 'VEHICLE_NAME'],
      previousAssistant: 'x'.repeat(PREVIOUS_ASSISTANT_MAX_CHARS + 50) + 'PENNY_END',
    });
    // Every line of the request is one of: the trip line, the names line,
    // Penny's previous message, or the message. If a fifth kind appears, the
    // TypeSafe sentence above no longer lists everything and must change.
    const stripped = sent
      .replace('Trip: TRIPNAME', '')
      .replace('Places on it: PLACE_A, VEHICLE_NAME', '')
      .replace(/Penny's previous message:\n…x+PENNY_END/, '')
      .replace('Message:\nMESSAGE', '')
      .trim();
    expect(stripped).toBe('');
    expect(sent).not.toContain('x'.repeat(PREVIOUS_ASSISTANT_MAX_CHARS + 1));
  });
});
