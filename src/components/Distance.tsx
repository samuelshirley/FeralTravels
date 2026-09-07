'use client';

import { formatKmDual } from '@/lib/units';
import { useUnits } from '@/components/UnitsContext';

interface DistanceProps {
  /** The canonical km value. Pass null/undefined for "not set". */
  km: number | null | undefined;
  /**
   * Visual layout. 'inline' renders both labels on one line — better for
   * tight cells. 'stacked' puts the secondary label on its own line below
   * the primary — better for the trip / leg list cards.
   */
  layout?: 'inline' | 'stacked';
  /**
   * Override the primary label with a custom node. The label is in the
   * user's own unit, so an override must be too — build it with `formatKm`
   * or `approxDistance`, never by writing a unit into a string.
   */
  primaryOverride?: React.ReactNode;
  /** Optional className to forward to the wrapping span/div. */
  className?: string;
  /** Optional inline style merged onto the wrapper. */
  style?: React.CSSProperties;
}

/**
 * Render a distance value in the user's unit: "{km} km" for metric users,
 * "{mi} mi" for imperial users — and nothing else. The old "km primary,
 * (mi) secondary" pairing for imperial users is gone (2026-09-04); the
 * `layout` prop survives for the day a secondary line returns, and today
 * both layouts render one label.
 *
 * The component is client-only because it reads from UnitsContext; pages
 * that render distances need to be inside a UnitsProvider (currently mounted
 * in the trip detail layout — see src/app/trips/[tripId]/page.tsx).
 */
export default function Distance({
  km,
  layout = 'stacked',
  primaryOverride,
  className,
  style,
}: DistanceProps) {
  const { units } = useUnits();
  const { primary, secondary } = formatKmDual(km, units);

  const primaryNode = primaryOverride ?? primary;

  if (!secondary) {
    // Metric user (or null km): just the primary label, no wrapper magic.
    return (
      <span className={className} style={style}>
        {primaryNode}
      </span>
    );
  }

  if (layout === 'inline') {
    return (
      <span className={className} style={style}>
        {primaryNode}{' '}
        <span style={{ color: 'var(--tp-subtle)', fontSize: '0.85em' }}>{secondary}</span>
      </span>
    );
  }

  // 'stacked' — primary on top, secondary as a smaller, lower-contrast
  // line beneath it. Wrapped in an inline-block so callers can drop this
  // into existing flex layouts without it stretching.
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15, ...style }}
    >
      <span>{primaryNode}</span>
      <span style={{ color: 'var(--tp-subtle)', fontSize: '0.78em' }}>{secondary}</span>
    </span>
  );
}
