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
   * Override the primary "X km" with a custom node (e.g. a `~${km} km`
   * prefix). The secondary mi label is appended unchanged.
   */
  primaryOverride?: React.ReactNode;
  /** Optional className to forward to the wrapping span/div. */
  className?: string;
  /** Optional inline style merged onto the wrapper. */
  style?: React.CSSProperties;
}

/**
 * Render a distance value with a unit-aware label.
 *
 * Behaviour:
 *   - For metric users: just "{km} km".
 *   - For imperial users: "{km} km" with a small light-contrast "(X mi)"
 *     beneath/beside it. We deliberately keep km as the *primary* label
 *     even for imperial users — the product decision is to teach metric.
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
