import { describe, expect, it } from 'vitest';
import {
  fallbackResendFor,
  IMAGE_ONLY_PLACEHOLDER,
  mediaTypeOfDataUrl,
  type FallbackRetryMessage,
} from './pennyFallbackRetry';

/**
 * Which bubble offers "Try again", and exactly what it resends — the one
 * decision both chat panels render. Penny's sentence is deliberately NOT the
 * same in every fixture here: the decision must not read it.
 */

const FALLBACK = "Sorry, I couldn't apply that cleanly — could you rephrase and try again?";
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

let n = 0;
const user = (content: string, extra: Partial<FallbackRetryMessage> = {}): FallbackRetryMessage => ({
  id: `u${++n}`,
  role: 'user',
  kind: 'ai',
  content,
  ...extra,
});
const penny = (content: string, extra: Partial<FallbackRetryMessage> = {}): FallbackRetryMessage => ({
  id: `a${++n}`,
  role: 'assistant',
  kind: 'ai',
  content,
  ...extra,
});
const fellBack = (extra: Partial<FallbackRetryMessage> = {}) =>
  penny(FALLBACK, { fallback_meta: { images: 0 }, ...extra });

describe('which message shows the button', () => {
  it('the latest Penny message, when the server marked it a fallback', () => {
    const reply = fellBack();
    expect(fallbackResendFor([user('Add a night in Porto'), reply])).toEqual({
      assistantId: reply.id,
      text: 'Add a night in Porto',
      images: [],
      handoff: false,
    });
  });

  it('never from the text: the same sentence without the flag shows nothing', () => {
    expect(fallbackResendFor([user('Add a night in Porto'), penny(FALLBACK)])).toBeNull();
    expect(fallbackResendFor([user('Add a night in Porto'), penny(FALLBACK, { fallback_meta: null })])).toBeNull();
  });

  it('the flag on any wording is enough — the decision does not read the reply', () => {
    const reply = penny('anything at all', { fallback_meta: { images: 0 } });
    expect(fallbackResendFor([user('Add a night in Porto'), reply])?.assistantId).toBe(reply.id);
  });

  it('only the latest: an older fallback shows nothing once Penny has answered again', () => {
    expect(
      fallbackResendFor([user('Add a night in Porto'), fellBack(), user('Add a night in Lisbon'), penny('Done.')]),
    ).toBeNull();
  });

  it('not once the driver has sent anything after it (typed, queued, or the resend itself)', () => {
    expect(fallbackResendFor([user('Add a night in Porto'), fellBack(), user('never mind')])).toBeNull();
    expect(
      fallbackResendFor([user('Add a night in Porto'), fellBack(), user('', { kind: 'handoff' })]),
    ).toBeNull();
  });

  it('not while the reply is still streaming', () => {
    expect(fallbackResendFor([user('Add a night in Porto'), fellBack({ streaming: true })])).toBeNull();
  });

  it('not when a synthetic bubble (the paywall) came after it: that is the latest Penny message', () => {
    expect(
      fallbackResendFor([user('Add a night in Porto'), fellBack(), penny('Your seven days are up.')]),
    ).toBeNull();
  });

  it('nothing on an empty transcript, or a fallback with no message above it', () => {
    expect(fallbackResendFor([])).toBeNull();
    expect(fallbackResendFor([fellBack()])).toBeNull();
  });

  it('not for a form answer: onboarding answers go to their own endpoint, not to Penny', () => {
    expect(
      fallbackResendFor([user('Hilux', { kind: 'form_answer' }), fellBack()]),
    ).toBeNull();
  });
});

describe('what gets resent', () => {
  it('the message word for word, from the nearest user row above the fallback', () => {
    const out = fallbackResendFor([
      user('Plan Girona to Lisbon'),
      penny('Here is the plan.'),
      user('  Add a rest day in Porto, please  '),
      fellBack(),
    ]);
    expect(out?.text).toBe('  Add a rest day in Porto, please  ');
    expect(out?.handoff).toBe(false);
  });

  it('the onboarding hand-off: the stored intent, resent AS a hand-off', () => {
    // As both panels hold it live and as the server returns it on reload: the
    // last setup answer, Penny's note, the hidden `handoff` row, then her reply.
    const out = fallbackResendFor([
      user('Girona to Lisbon, 5 h days', { kind: 'form_answer' }),
      penny('Leaving Friday 23 October.'),
      user('Girona to Lisbon, 5 h days', { kind: 'handoff' }),
      fellBack(),
    ]);
    expect(out).toMatchObject({ text: 'Girona to Lisbon, 5 h days', images: [], handoff: true });
  });

  it('with the photos it carried, while this session still holds them', () => {
    const out = fallbackResendFor([
      user('Add this campsite', { imageDataUrls: [PNG, JPEG] }),
      fellBack({ fallback_meta: { images: 2 } }),
    ]);
    expect(out).toMatchObject({
      text: 'Add this campsite',
      images: [
        { dataUrl: PNG, mediaType: 'image/png' },
        { dataUrl: JPEG, mediaType: 'image/jpeg' },
      ],
    });
  });

  it('a photo with no words: live it is the empty text, after a reload the placeholder is not resent as words', () => {
    const live = fallbackResendFor([user('', { imageDataUrls: [PNG] }), fellBack({ fallback_meta: { images: 1 } })]);
    expect(live).toMatchObject({ text: '', images: [{ dataUrl: PNG, mediaType: 'image/png' }] });
    const stored = fallbackResendFor([
      user(IMAGE_ONLY_PLACEHOLDER, { imageDataUrls: [PNG] }),
      fellBack({ fallback_meta: { images: 1 } }),
    ]);
    expect(stored?.text).toBe('');
  });

  it('NO button when the server counted photos this session no longer holds (after a reload)', () => {
    // Resending the words alone would be a different message.
    expect(
      fallbackResendFor([user('Add this campsite'), fellBack({ fallback_meta: { images: 1 } })]),
    ).toBeNull();
    expect(
      fallbackResendFor([user(IMAGE_ONLY_PLACEHOLDER), fellBack({ fallback_meta: { images: 1 } })]),
    ).toBeNull();
  });

  it('a driver who literally typed the placeholder, with no photo, gets it resent as typed', () => {
    expect(fallbackResendFor([user(IMAGE_ONLY_PLACEHOLDER), fellBack()])?.text).toBe(IMAGE_ONLY_PLACEHOLDER);
  });

  it('no button for a photo that is not a data URI — its media type is unknown', () => {
    expect(
      fallbackResendFor([user('look', { imageDataUrls: ['blob:abc'] }), fellBack({ fallback_meta: { images: 1 } })]),
    ).toBeNull();
  });
});

describe('mediaTypeOfDataUrl', () => {
  it('reads the media type off a data URI and refuses anything else', () => {
    expect(mediaTypeOfDataUrl(PNG)).toBe('image/png');
    expect(mediaTypeOfDataUrl('data:image/heic,abc')).toBe('image/heic');
    expect(mediaTypeOfDataUrl('https://example.test/a.png')).toBeNull();
  });
});
