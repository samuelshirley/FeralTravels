/**
 * Silly 5xx / network-fatal error messages.
 *
 * Shown at random in the full-screen ErrorNotifier modal whenever the client
 * can't reach the server OR the server threw something unrecoverable. Keep
 * them:
 *   - Non-political, non-topical. Jokes about real people age badly and
 *     alienate a chunk of users.
 *   - Short. Headline ≤ 8 words, body ≤ 16.
 *   - Reassuring. User should feel we're on it, not that the app is abandoned.
 *
 * Feel free to add or swap in your own. Order doesn't matter — we pick at
 * random per incident so the same crash doesn't always show the same message.
 */
export interface SillyError {
  headline: string;
  body: string;
  emoji: string; // fallback when public/errors/boom.gif is missing
}

export const SILLY_ERRORS: SillyError[] = [
  {
    headline: 'Penny chased a squirrel through the server room.',
    body: 'She’ll be right back. Please reload in a moment.',
    emoji: '🐿️',
  },
  {
    headline: 'A wombat chewed the uplink cable.',
    body: 'Our engineers are bribing it with snacks.',
    emoji: '🧷',
  },
  {
    headline: 'The hamsters unionised.',
    body: 'They’re in negotiations. Try again shortly.',
    emoji: '🐹',
  },
  {
    headline: 'A seagull absconded with a packet.',
    body: 'Give it a minute — it usually drops them.',
    emoji: '🐦',
  },
  {
    headline: 'Mercury is in retrograde. So are our servers.',
    body: 'Cosmic alignment pending. Retry shortly.',
    emoji: '🔮',
  },
];

export function pickSillyError(): SillyError {
  const i = Math.floor(Math.random() * SILLY_ERRORS.length);
  return SILLY_ERRORS[i] ?? SILLY_ERRORS[0];
}
