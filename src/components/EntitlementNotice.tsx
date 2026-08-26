import { blockNoticeFor } from '@/lib/paywallCopy';
import type { BlockReason } from '@/types/entitlement';

/**
 * The web soft block, as a plain server component.
 *
 * No `'use client'` and no fetch: the page already resolved the verdict on the
 * server, so the correct message is in the first HTML byte. A client component
 * polling `/api/me/entitlement` would flash the full UI — including a "+ New
 * trip" button — before deciding to take it away, which is a worse experience
 * than the block itself and briefly lies about what the account can do.
 *
 * This renders the MESSAGE only. Whether the trip list below it is still shown
 * is the caller's decision, because it differs by state: everything except
 * `refunded`/`revoked` keeps reading its own trips (see `canViewExistingTrips`
 * — viewing an itinerary makes no Anthropic calls, so blocking it would strand
 * someone mid-road-trip for nothing).
 */
export default function EntitlementNotice({ blockReason }: { blockReason: BlockReason }) {
  const notice = blockNoticeFor(blockReason);
  const selling = notice.tone === 'sell';

  return (
    <section
      role="status"
      data-block-reason={blockReason}
      style={{
        background: selling ? 'var(--tp-primary-muted)' : 'var(--tp-surface)',
        border: `1px solid ${selling ? 'rgba(78, 122, 176, 0.35)' : 'var(--tp-border-strong)'}`,
        borderRadius: 'var(--tp-radius-md)',
        padding: 20,
        marginBottom: 24,
        boxShadow: 'var(--tp-shadow-sm)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.15em',
          color: selling ? 'var(--tp-primary)' : 'var(--tp-muted)',
          marginBottom: 6,
        }}
      >
        {notice.eyebrow}
      </div>

      <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, fontWeight: 700, color: 'var(--tp-text)' }}>
        {notice.heading}
      </h2>

      {notice.body.map((paragraph) => (
        <p
          key={paragraph.slice(0, 24)}
          style={{
            margin: '0 0 10px',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--tp-muted)',
            maxWidth: '62ch',
          }}
        >
          {paragraph}
        </p>
      ))}

      <a
        href={notice.action.href}
        // The App Store link leaves the site; the mailto opens a mail client.
        // Only the former wants a new tab — a mailto in a new tab leaves an
        // empty one behind.
        {...(selling ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 4,
          padding: '9px 16px',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          textDecoration: 'none',
          background: selling ? 'var(--tp-primary)' : 'transparent',
          color: selling ? 'var(--tp-on-primary)' : 'var(--tp-primary)',
          border: selling ? 'none' : '1px solid var(--tp-border-strong)',
          boxShadow: selling ? 'var(--tp-shadow-sm)' : 'none',
        }}
      >
        {notice.action.label}
      </a>
    </section>
  );
}
