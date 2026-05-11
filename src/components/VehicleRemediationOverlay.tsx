'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { useViewport } from '@/lib/useMediaQuery';
import { useUnits } from '@/components/UnitsContext';
import {
  humanizeVehicleProfileAnswer,
  buildVehicleProfileQuestions,
  CARAVAN_WATER_GATE_KEY,
  type VehicleProfileQuestion,
} from '@/lib/vehicleProfile';

type RemediationQuestion = {
  key: string;
  kind:
    | 'text'
    | 'number'
    | 'integer'
    | 'select'
    | 'vehicle_pick'
    | 'handoff';
  label: string;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  optional?: boolean;
  min?: number;
  max?: number;
  multiline?: boolean;
};

interface RemediationSnap {
  needs_remediation: boolean;
  done: boolean;
  active_vehicle: { id: number; name: string } | null;
  question: RemediationQuestion | null;
  progress: { current: number; total: number } | null;
}

interface OverlayMsg {
  role: 'assistant' | 'user';
  content: string;
}

function answerLabelFromSubmit(
  q: RemediationSnap['question'],
  value: unknown,
  unitsPref: Parameters<typeof humanizeVehicleProfileAnswer>[2]
): string {
  if (!q) return String(value ?? '');
  if (q.kind === 'select') {
    if (value === 'yes') return 'Yes';
    if (value === 'no') return 'No';
  }
  if (q.key === CARAVAN_WATER_GATE_KEY) {
    if (value === 'yes') return 'Yes';
    if (value === 'no') return 'No';
  }
  const profileQs = buildVehicleProfileQuestions(unitsPref);
  const pq = profileQs.find((pq) => pq.key === q.key);
  if (pq) return humanizeVehicleProfileAnswer(pq as VehicleProfileQuestion, value, unitsPref);
  return String(value ?? '');
}

function appendDeduped(prev: OverlayMsg[], msg: OverlayMsg): OverlayMsg[] {
  const last = prev[prev.length - 1];
  if (last && last.role === msg.role && last.content === msg.content) return prev;
  return [...prev, msg];
}

export default function VehicleRemediationOverlay() {
  const router = useRouter();
  const viewport = useViewport();
  const { units } = useUnits();

  const [snapshot, setSnapshot] = useState<RemediationSnap | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [msgs, setMsgs] = useState<OverlayMsg[]>(() => [
    {
      role: 'assistant',
      content:
        'Before we dive into your trip plans, let’s tighten up one thing on file — missing vehicle profile details.',
    },
  ]);
  const titleId = 'vehicle-remediation-title';
  const scrollRef = useRef<HTMLDivElement>(null);
  const isMobileViewport = viewport === 'mobile';

  const fetchSnapshot = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiFetch<RemediationSnap>('/api/me/vehicle-remediation');
      setSnapshot(data);
      setDraft('');
      setError(null);

      if (data.done || !data.question) return true;

      setMsgs((prev) => appendDeduped(prev, { role: 'assistant', content: data.question!.label }));
      return false;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs, snapshot?.question]);

  async function submitValue(value: string | number | null) {
    if (!snapshot?.question || submitting) return;
    setSubmitting(true);
    setError(null);
    const q = snapshot.question;
    try {
      const userLabel = answerLabelFromSubmit(q, value, units);
      setMsgs((prev) => appendDeduped(prev, { role: 'user', content: userLabel }));

      const data = await apiFetch<RemediationSnap>('/api/me/vehicle-remediation', {
        method: 'POST',
        body: { questionKey: q.key, value },
      });

      setSnapshot(data);

      if (data.done || !data.needs_remediation) {
        setDraft('');
        router.refresh();
        return;
      }

      if (data.question) {
        setMsgs((prev) =>
          appendDeduped(prev, { role: 'assistant', content: data.question!.label })
        );
      }
      setDraft('');
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div style={backdropStyle}>
        <div role="dialog" aria-labelledby={titleId} style={mobileShell(isMobileViewport, true)}>
          <div style={headerStyle}>
            <h2 id={titleId} style={headingStyle}>
              Penny
            </h2>
          </div>
          <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Spinner size={16} thickness={2} color="var(--tp-primary)" />
            <span style={{ color: 'var(--tp-muted)', fontSize: 14 }}>Loading vehicle profile…</span>
          </div>
        </div>
      </div>
    );
  }

  if (snapshot?.done || !snapshot?.question) return null;

  const q = snapshot.question;

  return (
    <div style={backdropStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={mobileShell(isMobileViewport, false)}
      >
        <div style={headerStyle}>
          <div>
            <h2 id={titleId} style={headingStyle}>
              Update your vehicle
            </h2>
            <div style={subHeadingStyle}>Penny</div>
          </div>
          {snapshot.active_vehicle && (
            <div style={vehicleBadgeStyle}>{snapshot.active_vehicle.name}</div>
          )}
        </div>

        <div ref={scrollRef} style={transcriptWrap}>
          {msgs.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
              }}
            >
              <Bubble role={m.role}>{m.content}</Bubble>
            </div>
          ))}
        </div>

        <div style={composerOuter}>
          <div style={cardStyle}>
            {snapshot.progress && (
              <div style={progressStyle}>
                Vehicle profile · {snapshot.progress.current} of {snapshot.progress.total}
              </div>
            )}
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
              q.kind === 'integer' ||
              q.kind === 'handoff') && (
              <FreeformInput
                draft={draft}
                setDraft={setDraft}
                disabled={submitting}
                multiline={q.multiline || q.kind === 'handoff'}
                placeholder={q.placeholder}
                numeric={q.kind === 'number' || q.kind === 'integer'}
                submitting={submitting}
                onSkip={q.optional ? () => void submitValue(null) : null}
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
                  } else void submitValue(raw);
                }}
              />
            )}

            {error && (
              <div style={{ fontSize: 12, color: 'var(--tp-danger)', marginTop: 4 }}>{error}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, children }: { role: 'assistant' | 'user'; children: string }) {
  const isAssistant = role === 'assistant';
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 12,
        background: isAssistant ? 'var(--tp-surface-muted)' : 'var(--tp-primary)',
        color: isAssistant ? 'var(--tp-text)' : 'var(--tp-on-primary)',
        fontSize: 14,
        lineHeight: 1.45,
        border: isAssistant ? '1px solid var(--tp-border)' : 'none',
      }}
    >
      {children}
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
  submitting,
  onSkip,
  onSubmit,
}: {
  draft: string;
  setDraft: (s: string) => void;
  disabled: boolean;
  multiline: boolean;
  placeholder?: string;
  numeric: boolean;
  submitting: boolean;
  onSkip: (() => void) | null;
  onSubmit: (value: string) => void;
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
            data-testid="vehicle-remediation-input"
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
          data-testid="vehicle-remediation-next"
          onClick={() => onSubmit(draft.trim())}
          disabled={disabled || (!draft.trim() && !onSkip)}
          style={{
            ...primaryButtonStyle,
            opacity: disabled || (!draft.trim() && !onSkip) ? 0.5 : 1,
          }}
        >
          {submitting && <Spinner size={11} thickness={2} color="var(--tp-on-primary)" />}Next
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

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2000,
  background: 'var(--tp-overlay)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
};

function mobileShell(mobilePortrait: boolean, loadingOnly: boolean): React.CSSProperties {
  if (mobilePortrait) {
    return {
      width: '100%',
      height: loadingOnly ? 'auto' : '100%',
      maxHeight: loadingOnly ? 'auto' : '100%',
      margin: loadingOnly ? 0 : undefined,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--tp-surface)',
      borderRadius: loadingOnly ? 12 : 0,
      overflow: 'hidden',
      boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
      border: '1px solid var(--tp-border)',
    };
  }
  return {
    width: '100%',
    maxWidth: 480,
    maxHeight: 'min(620px, 92dvh)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--tp-surface)',
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
    border: '1px solid var(--tp-border)',
  };
}

const headerStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderBottom: '1px solid var(--tp-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexShrink: 0,
  background: 'var(--tp-surface-muted)',
};

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--tp-text)',
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: 11,
  
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--tp-muted)',
  marginTop: 2,
};

const vehicleBadgeStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--tp-muted)',
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid var(--tp-border)',
  background: 'var(--tp-primary-muted)',
  whiteSpace: 'nowrap',
};

const transcriptWrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const composerOuter: React.CSSProperties = {
  flexShrink: 0,
  borderTop: '1px solid var(--tp-border)',
  background: 'var(--tp-surface-muted)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
};

const cardStyle: React.CSSProperties = {
  padding: 12,
  margin: 12,
  background: 'var(--tp-primary-muted)',
  border: '1px solid rgba(78, 122, 176, 0.22)',
  borderRadius: 'var(--tp-radius-md)',
};

const progressStyle: React.CSSProperties = {
  fontSize: 10,
  
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--tp-primary)',
  marginBottom: 4,
};

const helpStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--tp-muted)',
  lineHeight: 1.35,
};

const chipStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 999,
  color: 'var(--tp-text)',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
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

const skipButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  color: 'var(--tp-muted)',
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm)',
  fontSize: 13,
  cursor: 'pointer',
};
