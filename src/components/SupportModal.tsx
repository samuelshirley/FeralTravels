'use client';

import { useEffect, useRef, useState } from 'react';

interface SupportModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SupportModal({ open, onClose }: SupportModalProps) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea when the modal opens
  useEffect(() => {
    if (open) {
      // Small delay so the DOM has rendered
      const t = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function handleClose() {
    if (status === 'sending') return;
    setMessage('');
    setStatus('idle');
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || status === 'sending') return;

    setStatus('sending');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!res.ok) throw new Error('Request failed');
      setStatus('sent');
    } catch {
      setStatus('error');
    }
  }

  if (!open) return null;

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--tp-surface, #fff)',
          borderRadius: 'var(--tp-radius-sm, 10px)',
          boxShadow: 'var(--tp-shadow-lg, 0 8px 30px rgba(0,0,0,0.12))',
          width: '100%',
          maxWidth: 460,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--tp-border, #e5e5e5)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--tp-text, #111)' }}>
            Contact Support
          </span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1,
              fontSize: 18,
              color: 'var(--tp-subtle, #999)',
            }}
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px' }}>
          {status === 'sent' ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--tp-text, #111)', margin: '0 0 6px' }}>
                Message sent
              </p>
              <p style={{ fontSize: 13, color: 'var(--tp-muted, #666)', margin: 0 }}>
                We&apos;ll get back to you as soon as we can.
              </p>
              <button
                type="button"
                onClick={handleClose}
                style={{
                  marginTop: 18,
                  padding: '8px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  border: '1px solid var(--tp-border, #ddd)',
                  background: 'var(--tp-surface, #fff)',
                  color: 'var(--tp-text, #111)',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <label
                htmlFor="support-message"
                style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--tp-muted, #666)', marginBottom: 6 }}
              >
                How can we help?
              </label>
              <textarea
                ref={textareaRef}
                id="support-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe the issue you're experiencing..."
                rows={5}
                maxLength={5000}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  fontSize: 14,
                  lineHeight: 1.5,
                  border: '1px solid var(--tp-border, #ddd)',
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  color: 'var(--tp-text, #111)',
                  background: 'var(--tp-surface, #fff)',
                  boxSizing: 'border-box',
                }}
              />
              {status === 'error' && (
                <p style={{ fontSize: 12, color: 'var(--tp-danger, #d44)', margin: '8px 0 0' }}>
                  Something went wrong. Please try again.
                </p>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 10,
                  marginTop: 14,
                }}
              >
                <button
                  type="button"
                  onClick={handleClose}
                  style={{
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 500,
                    borderRadius: 'var(--tp-radius-sm, 8px)',
                    border: '1px solid var(--tp-border, #ddd)',
                    background: 'var(--tp-surface, #fff)',
                    color: 'var(--tp-text, #111)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!message.trim() || status === 'sending'}
                  style={{
                    padding: '8px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 'var(--tp-radius-sm, 8px)',
                    border: 'none',
                    background: status === 'sending' ? 'var(--tp-muted, #999)' : 'var(--tp-primary, #3b82f6)',
                    color: 'var(--tp-on-primary, #fff)',
                    cursor: status === 'sending' ? 'not-allowed' : 'pointer',
                    opacity: !message.trim() ? 0.5 : 1,
                  }}
                >
                  {status === 'sending' ? 'Sending...' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
