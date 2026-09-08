'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SESSION_STORE_UNAVAILABLE_DIGEST } from '@/server/auth/errors';

/**
 * The app's error boundary. There was none before this — every server-side
 * exception rendered Next's stock "Application error: a server-side exception
 * has occurred", which tells the user nothing and offers them nothing.
 *
 * The specific branch is the reason it exists. When the session store is
 * unreachable, `auth()` used to return null and the page redirected to
 * `/login`, so a database blip looked exactly like being signed out — you would
 * sign in again, which is the one thing that cannot work while the store is
 * down. Saying so, and offering the retry, is the whole fix from the user's
 * side.
 *
 * `digest` rather than `message`: Next redacts a server component's error
 * message in production and passes through a digest the error already carries.
 * `SessionStoreUnavailableError` sets that literal for this line to read.
 *
 * Importing a value from `server/auth/errors` is safe and deliberate — the
 * digest is a plain string constant, and sharing it is what stops the two ends
 * of this contract drifting apart silently. The module has no `server-only`
 * import (that lives in guards.ts, which is why the classes were split out).
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const sessionStoreDown = error.digest === SESSION_STORE_UNAVAILABLE_DIGEST;
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  /**
   * `reset()` ALONE DOES NOT WORK HERE, and this was measured rather than
   * assumed: with the database stopped, restarted, and the button pressed, the
   * error screen came straight back while a fresh navigation to the same URL
   * loaded fine. `reset()` re-renders the boundary from the router's existing
   * cache; when the failure came from the server component's payload, that
   * cache still holds the failure. `router.refresh()` is what refetches it.
   *
   * Both, in that order, inside a transition — refresh to get a new payload,
   * reset to drop the error state — so the button does the thing its label
   * promises. A retry that cannot succeed is worse than no retry: this whole
   * change exists because the app told people something untrue about their
   * session.
   */
  const retry = () =>
    startRetry(() => {
      router.refresh();
      reset();
    });

  useEffect(() => {
    // Never silently swallow errors: the boundary is the user's half, this is
    // ours. The digest is what correlates it with the server log line.
    console.error('[error-boundary]', error.digest ?? '(no digest)', error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 20px',
        textAlign: 'center',
        background: 'var(--tp-bg, #f5f1ea)',
        color: 'var(--tp-text, #333)',
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: 'var(--tp-muted, #6b6b6b)',
            marginBottom: 10,
          }}
        >
          FERAL TRAVELS
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px', lineHeight: 1.25 }}>
          {sessionStoreDown ? "We can't reach your account" : 'Something went wrong'}
        </h1>

        <p
          style={{
            fontSize: 14,
            lineHeight: 1.65,
            color: 'var(--tp-muted, #6b6b6b)',
            margin: '0 0 22px',
          }}
        >
          {sessionStoreDown
            ? 'You have not been signed out — this is a problem on our side. Try again in a moment.'
            : "This page didn't load. Try again in a moment."}
        </p>

        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 28px',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 10,
            border: '1px solid var(--tp-border, #d9d2c5)',
            background: 'var(--tp-surface, #fff)',
            color: 'var(--tp-text, #333)',
            cursor: retrying ? 'default' : 'pointer',
            opacity: retrying ? 0.7 : 1,
          }}
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </main>
  );
}
