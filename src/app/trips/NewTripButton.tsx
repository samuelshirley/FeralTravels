'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

interface NewTripButtonProps {
  /**
   * Existing trip names for the current user, passed down by the trips page
   * server component. Used for instant client-side duplicate detection so the
   * user gets feedback as they type instead of after the round-trip. The
   * server still re-validates and is the authoritative source.
   */
  existingNames: string[];
  /**
   * When true, draw a subtle pulsing rust accent on the collapsed button so
   * first-time users notice how to create a trip.
   */
  emphasizeWhenNoTrips?: boolean;
}

export default function NewTripButton({
  existingNames,
  emphasizeWhenNoTrips = false,
}: NewTripButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-normalize the existing names once so each keystroke is just a Set
  // membership check. Same rule as the server: lowercase + trimmed.
  const takenSet = useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase())),
    [existingNames]
  );

  const trimmed = name.trim();
  const localDuplicate = trimmed.length > 0 && takenSet.has(trimmed.toLowerCase());
  const canSubmit = !busy && trimmed.length > 0 && !localDuplicate;

  // Synthesize the inline error: prefer the live client-side message while
  // typing, fall back to the last server error. Cleared on edit.
  const message = localDuplicate
    ? `A trip named "${trimmed}" already exists. Pick a different name.`
    : err;

  async function handleCreate() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const trip = await apiFetch<{ id: number }>(`/api/trips`, {
        method: 'POST',
        body: { name: trimmed },
        // We render our own inline error — opt out of the global toast so a
        // 409 from the server (race condition backstop) doesn't double-notify.
        skipGlobalErrorReport: true,
      });
      // Invalidate the /trips RSC cache so when the user navigates back from
      // the new trip's workspace, the list reflects the new row. Without this,
      // Next's client-side navigation cache serves the pre-create render and
      // the list looks stale until an unrelated mutation (e.g. delete) forces
      // a refresh.
      router.refresh();
      router.push(`/trips/${trip.id}`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create trip');
      setBusy(false);
      // Pull focus back into the input + select existing text so the user
      // can immediately retype a new name.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          position: 'relative',
          padding: '8px 16px',
          background: 'var(--tp-primary)',
          color: 'var(--tp-on-primary)',
          border: 'none',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: 'var(--tp-shadow-sm)',
        }}
      >
        {emphasizeWhenNoTrips && <span className="new-trip-corner-cue" aria-hidden />}
        + New trip
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={inputRef}
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            // Clear the stale server error as soon as the user edits the
            // name. Live duplicate detection happens via takenSet and is
            // recomputed on every render.
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Trip name"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'new-trip-error' : undefined}
          style={{
            padding: '8px 12px',
            background: 'var(--tp-surface-muted)',
            border: `1px solid ${message ? 'var(--tp-danger)' : 'var(--tp-border)'}`,
            borderRadius: 'var(--tp-radius-sm)',
            color: 'var(--tp-text)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          onClick={handleCreate}
          disabled={!canSubmit}
          style={{
            padding: '8px 14px',
            background: canSubmit ? 'var(--tp-primary)' : 'var(--tp-border)',
            color: canSubmit ? 'var(--tp-on-primary)' : 'var(--tp-muted)',
            border: 'none',
            borderRadius: 'var(--tp-radius-sm)',
            fontSize: 13,
            fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {busy && <Spinner size={11} color="var(--tp-primary)" thickness={2} />}
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setName('');
            setErr(null);
          }}
          style={{
            padding: '8px 12px',
            background: 'transparent',
            color: 'var(--tp-muted)',
            border: '1px solid var(--tp-border)',
            borderRadius: 'var(--tp-radius-sm)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      {message && (
        <span
          id="new-trip-error"
          role="alert"
          style={{ fontSize: 12, color: 'var(--tp-danger)' }}
        >
          {message}
        </span>
      )}
    </div>
  );
}
