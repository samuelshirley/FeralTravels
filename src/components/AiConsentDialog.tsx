'use client';

import { buttonStyle } from '@/components/ui/buttonStyle';
import { AI_CONSENT_COPY, PRIVACY_POLICY_PATH } from '@/lib/aiConsent';

/**
 * "Penny uses Anthropic's Claude" on the web — the same sheet, copy and
 * answers as mobile/components/AiConsentSheet.tsx. A modal dialog with no
 * click-outside dismiss: the guideline asks for an explicit answer.
 */
export default function AiConsentDialog({
  saving,
  error,
  onAgree,
  onNotNow,
}: {
  saving: boolean;
  error: string | null;
  onAgree: () => void;
  onNotNow: () => void;
}) {
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--tp-overlay, rgba(0,0,0,0.55))',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-consent-title"
        data-testid="ai-consent-sheet"
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--tp-surface)',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: '20px 20px 24px',
          boxShadow: '0 -8px 24px rgba(0,0,0,0.35)',
        }}
      >
        <h2 id="ai-consent-title" style={{ margin: 0, fontSize: 18, color: 'var(--tp-text)' }}>
          {AI_CONSENT_COPY.title}
        </h2>
        <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.45, color: 'var(--tp-muted)' }}>
          {AI_CONSENT_COPY.body}
        </p>
        <a
          href={PRIVACY_POLICY_PATH}
          target="_blank"
          rel="noreferrer"
          data-testid="ai-consent-privacy"
          style={{ display: 'inline-block', marginTop: 10, fontSize: 13, color: 'var(--tp-accent-400)' }}
        >
          {AI_CONSENT_COPY.privacyLink}
        </a>
        {error && (
          <div data-testid="ai-consent-error" role="alert" style={{ marginTop: 12, fontSize: 13, color: 'var(--tp-danger)' }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button
            type="button"
            data-testid="ai-consent-not-now"
            onClick={onNotNow}
            disabled={saving}
            style={{ ...buttonStyle('secondary'), flex: 1 }}
          >
            {AI_CONSENT_COPY.notNow}
          </button>
          <button
            type="button"
            data-testid="ai-consent-agree"
            onClick={onAgree}
            disabled={saving}
            style={{ ...buttonStyle('primary'), flex: 1, opacity: saving ? 0.6 : 1 }}
          >
            {AI_CONSENT_COPY.agree}
          </button>
        </div>
      </div>
    </div>
  );
}
