'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { useUnits } from '@/components/UnitsContext';
import type { UnitsPref } from '@/lib/units';

/**
 * Two-button segmented toggle for the user's metric/imperial display
 * preference. Kept lightweight (no third-party UI lib) and visually aligned
 * with the existing Vehicle profile button styling so it doesn't introduce
 * a new visual idiom.
 *
 * Clicking writes through to /api/me/preferences via the UnitsContext, which
 * also updates every other consumer (Distance components, vehicle form
 * labels, Penny's onboarding prompts on the next page load).
 */
export default function UnitsToggle() {
  const { units, setUnits, loading } = useUnits();
  const [error, setError] = useState<string | null>(null);

  async function pick(next: UnitsPref) {
    if (next === units || loading) return;
    setError(null);
    try {
      await setUnits(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to update preference.');
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--tp-muted)', marginBottom: 6 }}>
        Display units —{' '}
        <span style={{ color: 'var(--tp-subtle)' }}>
          stored values are always metric; this just changes what you see.
        </span>
      </div>
      <div
        role="tablist"
        aria-label="Display units"
        style={{
          display: 'inline-flex',
          border: '1px solid var(--tp-border)',
          borderRadius: 'var(--tp-radius-sm)',
          overflow: 'hidden',
        }}
      >
        {(['metric', 'imperial'] as const).map((u) => {
          const active = units === u;
          return (
            <button
              key={u}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => pick(u)}
              disabled={loading}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '7px 14px',
                border: 'none',
                cursor: loading ? 'default' : 'pointer',
                background: active ? 'var(--tp-primary)' : 'transparent',
                color: active ? 'var(--tp-on-primary)' : 'var(--tp-muted)',
                opacity: loading && !active ? 0.6 : 1,
                letterSpacing: '0.04em',
              }}
            >
              {u === 'metric' ? 'Metric (km)' : 'Imperial (mi)'}
            </button>
          );
        })}
      </div>
      {error && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--tp-danger)' }}>{error}</div>
      )}
    </div>
  );
}
