'use client';

import { useRef, useState, useEffect } from 'react';
import { verifyOtpAction, resendOtpAction } from './actions';

interface VerifyFormProps {
  email: string;
  callbackUrl: string;
  error?: string;
  resent?: boolean;
}

function describeError(code?: string): string | null {
  if (!code) return null;
  switch (code) {
    case 'InvalidCode':
      return 'That code is incorrect or has expired. Please try again or request a new one.';
    case 'RateLimited':
      return 'A code was already sent recently — please wait 60 seconds before requesting another.';
    case 'EmailSendFailed':
      return "Couldn't send a new code. Please try again or use Google sign-in.";
    default:
      return `Something went wrong (${code}). Please try again.`;
  }
}

/** Partially obscure the email for display: s***@gmail.com */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || local.length <= 2) return email;
  return `${local[0]}***@${domain}`;
}

export function VerifyForm({ email, callbackUrl, error, resent }: VerifyFormProps) {
  const NUM_DIGITS = 6;
  const [digits, setDigits] = useState<string[]>(Array(NUM_DIGITS).fill(''));
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);

  const code = digits.join('');
  const codeComplete = code.length === NUM_DIGITS && digits.every((d) => d !== '');

  // Auto-focus first box on mount.
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  // Auto-submit when all 6 digits are entered.
  useEffect(() => {
    if (codeComplete && !submitting) {
      setSubmitting(true);
      formRef.current?.requestSubmit();
    }
  }, [codeComplete, submitting]);

  function handleChange(index: number, value: string) {
    const cleaned = value.replace(/\D/g, '');

    // iOS auto-fill / password manager may inject the full code into one input.
    // If we get more than one digit, spread them across all boxes.
    if (cleaned.length > 1) {
      const chars = cleaned.slice(0, NUM_DIGITS).split('');
      const next = Array(NUM_DIGITS).fill('');
      for (let i = 0; i < chars.length; i++) next[i] = chars[i];
      setDigits(next);
      const firstEmpty = next.findIndex((d) => d === '');
      inputRefs.current[firstEmpty === -1 ? NUM_DIGITS - 1 : firstEmpty]?.focus();
      return;
    }

    // Normal single-digit entry.
    const digit = cleaned.slice(-1);
    const next = digits.slice();
    next[index] = digit;
    setDigits(next);
    if (digit && index < NUM_DIGITS - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        // Clear current box.
        const next = digits.slice();
        next[index] = '';
        setDigits(next);
      } else if (index > 0) {
        // Move back to previous box.
        inputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < NUM_DIGITS - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, NUM_DIGITS);
    if (!pasted) return;
    const next = Array(NUM_DIGITS).fill('');
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    // Focus the next empty box (or last if all filled).
    const firstEmpty = next.findIndex((d) => d === '');
    inputRefs.current[firstEmpty === -1 ? NUM_DIGITS - 1 : firstEmpty]?.focus();
  }

  const errorMessage = describeError(error);

  const digitBoxStyle: React.CSSProperties = {
    // Width is 100% of the wrapper div which handles the flex sizing.
    boxSizing: 'border-box' as const,
    aspectRatio: '1 / 1.2',
    textAlign: 'center',
    fontSize: 'clamp(18px, 5vw, 26px)',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    background: 'var(--tp-surface-muted)',
    border: '1px solid var(--tp-border)',
    borderRadius: 'var(--tp-radius-sm)',
    color: 'var(--tp-text)',
    outline: 'none',
    caretColor: 'transparent',
    cursor: 'default',
    transition: 'border-color 0.15s',
  };

  // Show a blinking cursor line in the focused empty box.
  const showCursor = (i: number) => focusedIndex === i && !digits[i];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <style>{`
        @keyframes otp-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
      {errorMessage && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--tp-radius-sm)',
            background: 'var(--tp-danger-muted)',
            border: '1px solid rgba(198, 93, 74, 0.35)',
            color: 'var(--tp-danger)',
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          {errorMessage}
        </div>
      )}

      {resent && !error && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--tp-radius-sm)',
            background: 'var(--tp-primary-muted)',
            border: '1px solid rgba(78, 122, 176, 0.35)',
            color: 'var(--tp-primary)',
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          A new code was sent to <strong>{maskEmail(email)}</strong>.
        </div>
      )}

      <p style={{ fontSize: 13, color: 'var(--tp-muted)', margin: '0 0 20px', lineHeight: 1.5 }}>
        We sent a 6-digit code to <strong>{maskEmail(email)}</strong>. Enter it below — it expires
        in 10 minutes.
      </p>

      {/* Code entry form */}
      <form ref={formRef} action={verifyOtpAction}>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="code" value={code} />
        <input type="hidden" name="callbackUrl" value={callbackUrl} />

        {/* 6 digit boxes */}
        <div
          style={{
            display: 'flex',
            gap: 'clamp(4px, 1.5vw, 8px)',
            justifyContent: 'center',
            marginBottom: 20,
            width: '100%',
          }}
        >
          {digits.map((digit, i) => (
            <div
              key={i}
              style={{
                position: 'relative',
                flex: '1 1 0',
                minWidth: 0,
                maxWidth: 52,
              }}
            >
              <input
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={digit}
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                onPaste={handlePaste}
                onFocus={(e) => {
                  setFocusedIndex(i);
                  e.target.select();
                }}
                onBlur={() => setFocusedIndex(null)}
                style={{
                  ...digitBoxStyle,
                  width: '100%',
                  borderColor: focusedIndex === i
                    ? 'var(--tp-primary)'
                    : digit
                    ? 'var(--tp-border-strong)'
                    : 'var(--tp-border)',
                }}
                aria-label={`Digit ${i + 1} of ${NUM_DIGITS}`}
              />
              {showCursor(i) && (
                <div
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 2,
                    height: '40%',
                    background: 'var(--tp-primary)',
                    borderRadius: 1,
                    animation: 'otp-blink 1s step-end infinite',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
          ))}
        </div>

        <button
          type="submit"
          disabled={submitting || !codeComplete}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: codeComplete ? 'var(--tp-primary)' : 'var(--tp-surface-muted)',
            color: codeComplete ? 'var(--tp-on-primary)' : 'var(--tp-subtle)',
            border: 'none',
            borderRadius: 'var(--tp-radius-sm)',
            fontSize: 14,
            fontWeight: 600,
            cursor: codeComplete ? 'pointer' : 'default',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {submitting ? 'Verifying…' : 'Verify code'}
        </button>
      </form>

      {/* Resend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          marginTop: 20,
          fontSize: 13,
          color: 'var(--tp-muted)',
        }}
      >
        Didn&apos;t get it?
        <form action={resendOtpAction} style={{ display: 'inline' }}>
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <button
            type="submit"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--tp-primary)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Resend code
          </button>
        </form>
      </div>

      {/* Back link */}
      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--tp-muted)' }}>
        <a
          href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
          style={{ color: 'var(--tp-subtle)', textDecoration: 'none' }}
        >
          ← Use a different email
        </a>
      </div>
    </div>
  );
}
