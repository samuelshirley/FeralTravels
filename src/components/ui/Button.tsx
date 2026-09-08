'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { BASE, VARIANTS, type ButtonVariant } from './buttonStyle';

/**
 * The web's button primitive. NEW with the Nocturne reskin.
 *
 * Until this file, the web had no button component at all: thirteen separate
 * inline `style={{}}` objects, each with its own copy of the padding, radius,
 * font-weight and accent fill. That was survivable while the accent was only a
 * colour. It stopped being survivable when Nocturne made primary buttons
 * OUTLINED — a change to three properties in thirteen places, with nothing to
 * stop the fourteenth from being written filled.
 *
 * The variants mirror `mobile/components/ui.tsx`'s `Button` exactly, so the two
 * platforms describe a button the same way.
 *
 * PRIMARY IS OUTLINED, NOT FILLED, and on this ground that is a legibility
 * decision as much as a stylistic one: `--tp-on-primary` (#e9e9ed) on a solid
 * #9184d9 scores 2.5:1 and fails as a label, where `--tp-accent-300` on the
 * dark ground is 11:1. A filled accent button is not available in this palette.
 *
 * DANGER keeps its hue but takes the same outlined shape as everything else.
 * The designs render Delete as a neutral outline; a destructive action that
 * looks like every other action is the worse trade.
 */

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: ButtonVariant;
  /** Renders as disabled and swallows the click. */
  disabled?: boolean;
  /** Fills the container. Buttons are inline-flex by default. */
  block?: boolean;
  /** Escape hatch for one-off geometry — never for colour. */
  style?: CSSProperties;
  title?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export default function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
  block = false,
  style,
  title,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ButtonProps) {
  // Hover as state rather than CSS, because there is no stylesheet to hang a
  // `:hover` on — the app styles inline and `globals.css` is global. Keyboard
  // focus is NOT handled here: `--tp-focus-ring` is applied by the browser's
  // own focus-visible outline, which is what a keyboard user expects.
  const [hot, setHot] = useState(false);
  const [rest, hover] = VARIANTS[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      style={{
        ...BASE,
        ...rest,
        ...(hot && !disabled ? hover : null),
        ...(block ? { display: 'flex', width: '100%' } : null),
        ...(disabled ? { opacity: 0.6, cursor: 'default' } : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
