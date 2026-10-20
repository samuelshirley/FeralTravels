import { describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_COPY,
  createAiConsentController,
  type AiConsentSnapshot,
} from './aiConsent';

/**
 * The consent sheet's logic, exactly as both panels run it (the phone through
 * mobile/shared/lib/aiConsent.ts, a byte-for-byte mirror). What it must hold:
 * nothing waiting on the sheet goes ahead until the agreement is STORED;
 * "Not now" refuses and is remembered for the screen; a failed save is shown,
 * never swallowed; an account that already agreed is never asked.
 */

function make(opts: { consented?: boolean | 'throws'; save?: 'ok' | 'throws' } = {}) {
  const snapshots: AiConsentSnapshot[] = [];
  const fetchConsent = vi.fn(async () => {
    if (opts.consented === 'throws') throw new Error('offline');
    return opts.consented ?? false;
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

describe('the consent copy', () => {
  it('names the company, the model and every kind of data that goes', () => {
    expect(AI_CONSENT_COPY.title).toBe("Penny uses Anthropic's Claude");
    for (const word of ['messages', 'photos', 'trip details', 'location', 'Anthropic', 'Claude']) {
      expect(AI_CONSENT_COPY.body).toContain(word);
    }
    expect(AI_CONSENT_COPY.agree).toBe('Agree');
    expect(AI_CONSENT_COPY.notNow).toBe('Not now');
  });
});
