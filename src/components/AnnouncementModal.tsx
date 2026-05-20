'use client';

import { useEffect, useState } from 'react';

interface Announcement {
  id: string;
  title: string;
  body: string;
  buttonText: string;
}

/**
 * One-time announcement popup. Fetches the newest undismissed active
 * announcement on mount. Once the user clicks the CTA button, we POST
 * a dismissal and the modal never shows again for that user + announcement.
 */
export default function AnnouncementModal() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/announcements/active')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.announcement) {
          setAnnouncement(data.announcement);
          // Small delay so the page behind is visible first, feels more natural
          requestAnimationFrame(() => {
            if (!cancelled) setVisible(true);
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDismiss() {
    if (!announcement || dismissing) return;
    setDismissing(true);
    try {
      await fetch('/api/announcements/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcementId: announcement.id }),
      });
    } catch {
      // Best-effort — if it fails, they'll see it again next visit
    }
    setVisible(false);
    // Wait for fade-out animation before unmounting
    setTimeout(() => setAnnouncement(null), 250);
  }

  if (!announcement) return null;

  return (
    <div
      data-testid="announcement-modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: 20,
        opacity: visible ? 1 : 0,
        transition: 'opacity 250ms ease',
      }}
    >
      <div
        data-testid="announcement-modal"
        style={{
          background: 'var(--tp-surface, #fff)',
          borderRadius: 'var(--tp-radius-md, 12px)',
          boxShadow: '0 8px 40px rgba(0, 0, 0, 0.18)',
          width: '100%',
          maxWidth: 420,
          overflow: 'hidden',
          transform: visible ? 'translateY(0)' : 'translateY(12px)',
          transition: 'transform 250ms ease',
        }}
      >
        {/* Accent bar */}
        <div
          style={{
            height: 4,
            background: 'linear-gradient(90deg, var(--tp-primary, #4E7AB0), var(--tp-accent-warm, #C97B63))',
          }}
        />

        <div style={{ padding: '28px 24px 24px' }}>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--tp-text, #333)',
              margin: '0 0 12px',
              lineHeight: 1.3,
            }}
          >
            {announcement.title}
          </h2>

          <p
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--tp-muted, #5C5C5C)',
              margin: '0 0 24px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {announcement.body}
          </p>

          <button
            data-testid="announcement-dismiss-btn"
            onClick={handleDismiss}
            disabled={dismissing}
            style={{
              width: '100%',
              padding: '12px 20px',
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'inherit',
              borderRadius: 'var(--tp-radius-sm, 8px)',
              border: 'none',
              background: dismissing
                ? 'var(--tp-muted, #999)'
                : 'var(--tp-primary, #4E7AB0)',
              color: 'var(--tp-on-primary, #fff)',
              cursor: dismissing ? 'not-allowed' : 'pointer',
              transition: 'background 150ms ease',
            }}
          >
            {announcement.buttonText}
          </button>
        </div>
      </div>
    </div>
  );
}
