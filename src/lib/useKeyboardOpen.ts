'use client';

import { useState, useEffect } from 'react';

/**
 * Detects whether the mobile virtual keyboard is likely open by comparing
 * the VisualViewport height to the window outer/inner height.
 *
 * Uses the VisualViewport API (supported in all modern mobile browsers).
 * On desktop or when VisualViewport isn't available, always returns false.
 *
 * The threshold (150px) avoids false positives from browser chrome changes
 * (address bar collapsing etc.) while still catching even compact keyboards.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Snapshot the "full" height on mount (before any keyboard opens).
    // We use this as the baseline to detect shrinkage. On iOS with
    // interactive-widget=resizes-content the layout viewport itself
    // changes, but visualViewport still reports the smaller value.
    let fullHeight = vv.height;

    const update = () => {
      // Re-capture full height when keyboard closes (viewport grows back).
      if (vv.height > fullHeight) fullHeight = vv.height;

      const shrinkage = fullHeight - vv.height;
      setOpen(shrinkage > 150);
    };

    vv.addEventListener('resize', update);
    // Also listen on scroll — iOS Safari fires scroll on the visual viewport
    // when the keyboard slides in/out even when resize doesn't re-fire.
    vv.addEventListener('scroll', update);

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return open;
}
