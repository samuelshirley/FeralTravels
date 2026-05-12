'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

/**
 * Lightweight vehicle-remediation form shown inside the ChatPanel composer
 * area — same UX pattern as OnboardingForm but hits the /api/me/vehicle-remediation
 * endpoint to fill in missing vehicle profile fields.
 *
 * No SSR, no overlay, no hydration risk.
 */

type QuestionKind = 'text' | 'number' | 'integer' | 'select' | 'vehicle_pick' | 'handoff';

interface Question {
  key: string;
  kind: QuestionKind;
  label: string;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  optional?: boolean;
  min?: number;
  max?: number;
  multiline?: boolean;
}

interface Snapshot {
  needs_remediation: boolean;
  done: boolean;
  active_vehicle: { id: number; name: string } | null;
  question: Question | null;
  progress: { current: number; total: number } | null;
  garage_empty?: boolean;
}

interface VehicleRemediationFormProps {
  /** Called with user-visible labels so the parent can append chat bubbles. */
  onAnswer: (userLabel: string, questionLabel: string) => void;
  /** Called when all remediation questions are answered. */
  onComplete: () => void;
}

export default function VehicleRemediationForm({
  onAnswer,
  onComplete,
}: VehicleRemediationFormProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const didFetchRef = useRef(false);

  const fetchSnapshot = useCallback(async () => {
    try {
      const data = await apiFetch<Snapshot>('/api/me/vehicle-remediation');
      setSnapshot(data);
      setDraft('');
      setError(null);

      if (data.done || !data.needs_remediation) {
        onComplete();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onComplete]);

  useEffect(() => {
    if (didFetchRef.current) return;
    didFetchRef.current = true;
    void fetchSnapshot();
  }, [fetchSnapshot]);

  async function submitValue(value: string | number | null) {
    if (!snapshot?.question || submitting) return;
    setSubmitting(true);
    setError(null);
    const question = snapshot.question;

    try {
      const data = await apiFetch<Snapshot>('/api/me/vehicle-remediation', {
        method: 'POST',
        body: { questionKey: question.key, value },
      });

      // Build a user-friendly label for the chat bubble
      let userLabel = String(value ?? 'Skipped');
      if (question.kind === 'select' && question.options) {
        const match = question.options.find((o) => o.value === value);
        if (match) userLabel = match.label;
      }

      onAnswer(userLabel, question.label);

      if (data.done || !data.needs_remediation) {
        onComplete();
        return;
      }

      setSnapshot(data);
      setDraft('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div style={composerPad}>
        <div style={{ ...cardStyle, color: 'var(--tp-muted)', fontSize: 13 }}>
          <Spinner size={12} thickness={2} color="var(--tp-primary)" /> Loading vehicle profile…
        </div>
      </div>
    );
  }

  if (!snapshot?.question) {
    return null;
  }

  const q = snapshot.question;

  return (
    <div style={composerPad}>
      <div style={cardStyle}>
        {snapshot.active_vehicle && (
          <div style={vehicleLabelStyle}>
            Vehicle: {snapshot.active_vehicle.name}
          </div>
        )}
        {snapshot.progress && (
          <div style={progressStyle}>
            Vehicle profile · {snapshot.progress.current} of {snapshot.progress.total}
          </div>
        )}
        <div style={questionLabelStyle}>{q.label}</div>
        {q.help && <div style={helpStyle}>{q.help}</div>}

        {q.kind === 'select' && (
          <SelectPicker
            options={q.options ?? []}
            disabled={submitting}
            onPick={(v) => void submitValue(v)}
          />
        )}

        {(q.kind === 'text' ||
          q.kind === 'number' ||
          q.kind === 'integer') && (
          <FreeformInput
            draft={draft}
            setDraft={setDraft}
            disabled={submitting}
            multiline={!!q.multiline}
            placeholder={q.placeholder}
            numeric={q.kind === 'number' || q.kind === 'integer'}
            onSubmit={(raw) => {
              if (raw === '' && q.optional) return void submitValue(null);
              if (raw === '' && !q.optional) {
                setError('This one is required.');
                return;
              }
              if (q.kind === 'number' || q.kind === 'integer') {
                const n = Number(raw);
                if (!Number.isFinite(n)) {
                  setError('Please enter a number.');
                  return;
                }
                void submitValue(n);
              } else {
                void submitValue(raw);
              }
            }}
            onSkip={q.optional ? () => void submitValue(null) : null}
            submitting={submitting}
          />
        )}

        {error && <div style={errorStyle}>{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SelectPicker({
  options,
  disabled,
  onPick,
}: {
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onPick(o.value)}
          disabled={disabled}
          style={{ ...chipStyle, opacity: disabled ? 0.5 : 1 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FreeformInput({
  draft,
  setDraft,
  disabled,
  multiline,
  placeholder,
  numeric,
  onSubmit,
  onSkip,
  submitting,
}: {
  draft: string;
  setDraft: (s: string) => void;
  disabled: boolean;
  multiline: boolean;
  placeholder?: string;
  numeric: boolean;
  onSubmit: (value: string) => void;
  onSkip: (() => void) | null;
  submitting: boolean;
}) {
  const inputStyle = {
    flex: 1,
    minWidth: 0,
    padding: '8px 12px',
    background: 'var(--tp-surface-muted)',
    border: '1px solid var(--tp-border)',
    borderRadius: 'var(--tp-radius-sm)',
    color: 'var(--tp-text)',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'none' as const,
    lineHeight: 1.4,
  };

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
        {multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            rows={3}
            autoFocus
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit(draft.trim());
              }
            }}
            style={{ ...inputStyle, minHeight: 60, maxHeight: 200 }}
          />
        ) : (
          <input
            type={numeric ? 'number' : 'text'}
            inputMode={numeric ? 'decimal' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            autoFocus
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit(draft.trim());
              }
            }}
            style={inputStyle}
          />
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onSubmit(draft.trim())}
          disabled={disabled || (!draft.trim() && !onSkip)}
          style={{
            ...primaryButtonStyle,
            opacity: disabled || (!draft.trim() && !onSkip) ? 0.5 : 1,
          }}
        >
          {submitting && <Spinner size={11} thickness={2} color="var(--tp-on-primary)" />}
          Next
        </button>
        {onSkip && (
          <button type="button" onClick={onSkip} disabled={disabled} style={skipButtonStyle}>
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — inline to match codebase conventions.

const composerPad = {
  padding: '12px 16px',
  borderTop: '1px solid var(--tp-border)',
  background: 'var(--tp-surface-muted)',
  flexShrink: 0,
  paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
} as const;

const cardStyle = {
  padding: 12,
  background: 'var(--tp-primary-muted)',
  border: '1px solid rgba(78, 122, 176, 0.22)',
  borderRadius: 'var(--tp-radius-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
} as const;

const vehicleLabelStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--tp-primary)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
};

const progressStyle = {
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: 'var(--tp-primary)',
  marginBottom: 2,
};

const questionLabelStyle = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--tp-text)',
  lineHeight: 1.4,
};

const helpStyle = {
  fontSize: 12,
  color: 'var(--tp-muted)',
  lineHeight: 1.4,
};

const errorStyle = {
  fontSize: 12,
  color: 'var(--tp-danger)',
  marginTop: 4,
};

const chipStyle = {
  padding: '8px 14px',
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 999,
  color: 'var(--tp-text)',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryButtonStyle = {
  padding: '8px 16px',
  background: 'var(--tp-primary)',
  color: 'var(--tp-on-primary)',
  border: 'none',
  borderRadius: 'var(--tp-radius-sm)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const skipButtonStyle = {
  padding: '8px 14px',
  background: 'transparent',
  color: 'var(--tp-muted)',
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm)',
  fontSize: 13,
  cursor: 'pointer',
};
