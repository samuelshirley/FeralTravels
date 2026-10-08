/**
 * The "Show edit payload" expander inside an admin chat bubble.
 *
 * Static prop, no request: pins that the JSON is hidden until asked for, shown
 * verbatim, and hidden again on the second tap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import ChangesToggle from './ChangesToggle';

const PRETTY = JSON.stringify({ addStop: { name: 'Moab', type: 'other' } }, null, 2);

describe('ChangesToggle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts collapsed', () => {
    const { container } = render(<ChangesToggle pretty={PRETTY} />);
    expect(screen.getByRole('button', { name: 'Show edit payload' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('expands to the payload verbatim, and collapses again, without a request', () => {
    const { container } = render(<ChangesToggle pretty={PRETTY} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show edit payload' }));
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe(PRETTY);
    expect(screen.getByRole('button', { name: 'Hide edit payload' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide edit payload' }));
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show edit payload' })).toBeInTheDocument();

    expect(fetch).not.toHaveBeenCalled();
  });
});
