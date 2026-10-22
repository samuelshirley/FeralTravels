import type { ChatFallbackMeta, ChatKind } from '../types/trip';

/**
 * "Try again" on Penny's dead end ("Sorry, I couldn't apply that cleanly — …").
 *
 * ONE decision, shared by both chat panels: which bubble shows the button, and
 * exactly what tapping it sends. The panels only render the answer and hand it
 * to their normal send path — they never decide for themselves, and neither
 * this file nor they ever look at what Penny's reply SAYS. The reply is a
 * fallback because the server marked it so (`fallback_meta`, on the row and on
 * the `applied` event), and that mark is the only thing read here.
 *
 * Mirrored to mobile/shared by scripts/sync-shared.mjs.
 */

/** The button's whole label. Penny's own sentence above it is left alone. */
export const TRY_AGAIN_LABEL = 'Try again';

/**
 * What the replan route stores as the user's message when it carried only
 * photos. The route and this file share the one definition, so a resend can
 * tell "a photo with no words" from a driver who typed these exact characters.
 */
export const IMAGE_ONLY_PLACEHOLDER = '(image only)';

/** The fields of a chat-panel message this decision reads — both panels' `UIMessage` fit. */
export interface FallbackRetryMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: ChatKind;
  content: string;
  fallback_meta?: ChatFallbackMeta | null;
  /** `data:` URIs of the photos a user message carried — held in this session only. */
  imageDataUrls?: string[];
  /** Still streaming: not a settled reply yet. */
  streaming?: boolean;
}

export interface FallbackResendImage {
  dataUrl: string;
  mediaType: string;
}

/** Exactly what "Try again" sends, through the panel's normal send path. */
export interface FallbackResend {
  /** The fallback bubble that shows the button. */
  assistantId: string;
  /** The message as it was sent — '' for a photo with no words. */
  text: string;
  images: FallbackResendImage[];
  /**
   * True when the turn that fell back was the onboarding hand-off: the stored
   * trip intent fired at Penny, persisted as kind `handoff` and never drawn as
   * a bubble. Resent as a hand-off again — the same payload, the same hidden
   * row — rather than as something the driver appears to have typed.
   */
  handoff: boolean;
}

/** `data:image/png;base64,…` → `image/png`; null when it is not a data URI. */
export function mediaTypeOfDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match ? match[1] : null;
}

/**
 * What "Try again" resends, or null when no bubble should offer it.
 *
 * The button belongs to the LATEST assistant message only, only while that
 * message is a settled fallback, and only while nothing the driver sent has
 * come after it. What it resends is the user row that produced the fallback —
 * the nearest user message above it — word for word, with its photos and as a
 * hand-off when it was one.
 *
 * Null rather than an approximation whenever the resend could not be the same
 * message: a form answer (onboarding's own endpoint owns those), or photos the
 * server counted but this session no longer holds — the transcript keeps no
 * photos, so after a reload a message that carried them cannot be resent
 * exactly, and sending its words alone would be a different message.
 */
export function fallbackResendFor(
  messages: readonly FallbackRetryMessage[],
): FallbackResend | null {
  let assistantAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantAt = i;
      break;
    }
  }
  if (assistantAt < 0) return null;
  const reply = messages[assistantAt];
  const meta = reply.fallback_meta;
  if (!meta || reply.streaming) return null;

  // Anything the driver sent after it — typed, queued, or a resend already on
  // its way — means the dead end has been answered.
  if (messages.slice(assistantAt + 1).some((m) => m.role === 'user')) return null;

  let source: FallbackRetryMessage | null = null;
  for (let i = assistantAt - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      source = messages[i];
      break;
    }
  }
  if (!source) return null;
  if (source.kind !== 'ai' && source.kind !== 'handoff') return null;

  const held = source.imageDataUrls ?? [];
  if (held.length !== meta.images) return null;
  const images: FallbackResendImage[] = [];
  for (const dataUrl of held) {
    const mediaType = mediaTypeOfDataUrl(dataUrl);
    if (!mediaType) return null;
    images.push({ dataUrl, mediaType });
  }

  const text =
    images.length > 0 && source.content === IMAGE_ONLY_PLACEHOLDER ? '' : source.content;
  if (!text.trim() && images.length === 0) return null;

  return { assistantId: reply.id, text, images, handoff: source.kind === 'handoff' };
}
