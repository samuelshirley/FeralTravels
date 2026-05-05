'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { OnboardingState } from '@/types/trip';
import Spinner from '@/components/Spinner';

// Client-side mirror of the server's question shape (src/server/onboarding.ts).
// We don't share the file because the server imports drizzle and other
// server-only modules; the schema is duplicated in its simplest form.
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
  state: OnboardingState;
  question: Question | null;
  vehicles: Array<{ id: number; name: string; is_default: boolean }>;
  progress: { current: number; total: number } | null;
}

interface AnswerResult {
  next: Snapshot;
  answerLabel: string;
  didHandoff: boolean;
}

interface OnboardingFormProps {
  tripId: number;
  initialState: OnboardingState;
  /** Called with an optimistic user bubble to append to chat. */
  onAnswer: (userLabel: string, questionLabel: string) => void;
  /**
   * Called when onboarding is complete. Receives the user's handoff text so
   * the parent can call /api/trip/replan with it. The parent should also
   * refetch the trip (to pick up the new onboarding_state='done').
   */
  onHandoff: (handoffText: string) => Promise<void>;
}

export default function OnboardingForm({
  tripId,
  initialState,
  onAnswer,
  onHandoff,
}: OnboardingFormProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(initialState !== 'done');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const didFetchRef = useRef(false);

  const fetchSnapshot = useCallback(async () => {
    try {
      const data = await apiFetch<Snapshot>(`/api/trips/${tripId}/onboarding`);
      setSnapshot(data);
      setDraft('');
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    if (didFetchRef.current) return;
    if (initialState === 'done') return;
    didFetchRef.current = true;
    void fetchSnapshot();
  }, [fetchSnapshot, initialState]);

  async function submitValue(value: string | number | null) {
    if (!snapshot?.question || submitting) return;
    setSubmitting(true);
    setError(null);
    const question = snapshot.question;

    try {
      const result = await apiFetch<AnswerResult>(`/api/trips/${tripId}/onboarding`, {
        method: 'POST',
        body: { questionKey: question.key, value },
      });

      if (result.didHandoff) {
        // Dismiss the form immediately so the chat "Thinking…" animation is
        // visible right away — don't wait for Penny's full response first.
        setSnapshot({ state: 'done', question: null, vehicles: [], progress: null });
        const handoffText = typeof value === 'string' ? value : String(value);
        await onHandoff(handoffText);
      } else {
        onAnswer(result.answerLabel, question.label);
        setSnapshot(result.next);
      }
      setDraft('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (initialState === 'done' || snapshot?.state === 'done') {
    return null;
  }

  if (loading) {
    return (
      <div style={composerPad}>
        <div style={{ ...cardStyle, color: 'var(--tp-muted)', fontSize: 13 }}>
          <Spinner size={12} thickness={2} color="var(--tp-primary)" /> Loading setup…
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
        {snapshot.progress && (
          <div style={progressStyle}>
            Setup · {snapshot.progress.current} of {snapshot.progress.total}
          </div>
        )}
        <div style={questionLabelStyle}>{q.label}</div>
        {q.help && <div style={helpStyle}>{q.help}</div>}

        {q.kind === 'vehicle_pick' && (
          <VehiclePicker
            vehicles={snapshot.vehicles}
            disabled={submitting}
            onPick={(v) => void submitValue(v)}
          />
        )}

        {q.kind === 'select' && (
          <SelectPicker
            options={q.options ?? []}
            disabled={submitting}
            onPick={(v) => void submitValue(v)}
          />
        )}

        {(q.kind === 'text' || q.kind === 'number' || q.kind === 'integer' || q.kind === 'handoff') && (
          <FreeformInput
            draft={draft}
            setDraft={setDraft}
            disabled={submitting}
            multiline={q.multiline || q.kind === 'handoff'}
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
            submitLabel={q.kind === 'handoff' ? 'Send to Penny' : 'Next'}
            submitting={submitting}
          />
        )}

        {error && <div style={errorStyle}>{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function VehiclePicker({
  vehicles,
  disabled,
  onPick,
}: {
  vehicles: Snapshot['vehicles'];
  disabled: boolean;
  onPick: (value: string | number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      {vehicles.map((v) => (
        <button
          key={v.id}
          onClick={() => onPick(v.id)}
          disabled={disabled}
          style={{ ...pickButtonStyle, opacity: disabled ? 0.5 : 1 }}
        >
          <span style={{ fontWeight: 600 }}>{v.name}</span>
          {v.is_default && <span style={pillStyle}>default</span>}
        </button>
      ))}
      <button
        onClick={() => onPick('new')}
        disabled={disabled}
        style={{ ...pickButtonStyle, borderStyle: 'dashed', opacity: disabled ? 0.5 : 1 }}
      >
        + Add a new vehicle
      </button>
    </div>
  );
}

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
  submitLabel,
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
  submitLabel: string;
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
          onClick={() => onSubmit(draft.trim())}
          disabled={disabled || (!draft.trim() && !onSkip)}
          style={{
            ...primaryButtonStyle,
            opacity: disabled || (!draft.trim() && !onSkip) ? 0.5 : 1,
          }}
        >
          {submitting && <Spinner size={11} thickness={2} color="var(--tp-on-primary)" />}
          {submitLabel}
        </button>
        {onSkip && (
          <button onClick={onSkip} disabled={disabled} style={skipButtonStyle}>
            Skip
          </button>
        )}
        {multiline && (
          <span style={{ fontSize: 10, color: 'var(--tp-subtle)' }}>
            ⌘+Enter to send
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles. Kept inline to match the rest of the codebase, which doesn't use a
// CSS-in-JS library.

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

const pickButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm)',
  color: 'var(--tp-text)',
  fontSize: 13,
  cursor: 'pointer',
  textAlign: 'left' as const,
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

const pillStyle = {
  padding: '2px 6px',
  fontSize: 10,
  background: 'var(--tp-success-muted)',
  color: 'var(--tp-success)',
  borderRadius: 4,
  
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
