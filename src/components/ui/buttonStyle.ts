/**
 * Button's style recipe, deliberately OUTSIDE `Button.tsx`.
 *
 * `Button.tsx` is `'use client'`, and in the RSC graph every export of a
 * `'use client'` module compiles to a client-reference proxy rather than the
 * value itself — so a server component that imports a plain helper from one
 * and CALLS it gets `TypeError: <name> is not a function` at render time,
 * with nothing in `tsc` to warn it. That is not hypothetical: `buttonStyle`
 * lived in `Button.tsx` and `src/app/settings/page.tsx` called it, which
 * 500'd `/settings` for the admin from 2026-09-03 until 2026-09-08 (digest
 * 1097810709). The build output said so plainly —
 * the built bundle held a `createProxy(...)` reference to
 * `src/components/ui/Button.tsx#buttonStyle` rather than the function.
 *
 * So the rule this file exists to enforce: values that BOTH sides may need
 * live in a module with no `'use client'` directive, and the client component
 * imports them from here. Nothing re-exports `buttonStyle` from `Button.tsx`
 * — a re-export would move the footgun rather than remove it, since importing
 * it from the client module would still yield a proxy.
 *
 * `serverClientBoundaryGuard.test.ts` fails the suite if the class comes back
 * anywhere in `src/app` or `src/server`.
 */
import type { CSSProperties } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export const BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: '1px solid transparent',
  borderRadius: 'var(--tp-radius-md)',
  padding: '10px 16px',
  fontFamily: 'var(--tp-font-sans)',
  fontSize: 'var(--tp-text-base)',
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
  WebkitAppearance: 'none',
  appearance: 'none',
};

/** [rest, hover/active] pairs, so the hover state lives beside the rest state. */
export const VARIANTS: Record<ButtonVariant, [CSSProperties, CSSProperties]> = {
  primary: [
    {
      background: 'var(--tp-primary-tint)',
      borderColor: 'var(--tp-primary)',
      color: 'var(--tp-accent-300)',
    },
    {
      background: 'var(--tp-primary-muted)',
      borderColor: 'var(--tp-accent-400)',
      color: 'var(--tp-accent-300)',
    },
  ],
  secondary: [
    {
      background: 'var(--tp-surface)',
      borderColor: 'var(--tp-border-strong)',
      color: 'var(--tp-text)',
    },
    {
      background: 'var(--tp-surface-muted)',
      borderColor: 'var(--tp-border-strong)',
      color: 'var(--tp-text)',
    },
  ],
  danger: [
    {
      background: 'var(--tp-danger-muted)',
      borderColor: 'var(--tp-danger-border)',
      color: 'var(--tp-danger)',
    },
    {
      background: 'var(--tp-danger-muted)',
      borderColor: 'var(--tp-danger)',
      color: 'var(--tp-danger)',
    },
  ],
};

/**
 * The same recipe as a plain style object, for the actions that are LINKS
 * rather than buttons — "Open vehicle setup" and the trips-list clone pill
 * navigate, so they must stay an `<a>`/`<Link>` for middle-click, right-click
 * and the status bar. Wrapping a link in a <button> to reuse the component
 * would trade all three away for visual consistency that this export gives
 * for free.
 *
 * No hover state: a link has a stylesheet-free `:hover` problem of its own,
 * and the border already carries the affordance.
 */
export function buttonStyle(variant: ButtonVariant = 'primary'): CSSProperties {
  return { ...BASE, ...VARIANTS[variant][0], textDecoration: 'none' };
}
