/**
 * The onboarding calendar: a day becomes a LOCAL `YYYY-MM-DD`, and it closes
 * the way every other overlay does — Escape, or a click anywhere else, but not
 * a click on the chip that opened it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CalendarPopover, { monthGrid } from './CalendarPopover';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('monthGrid', () => {
  it('starts on Monday, with blanks before the 1st', () => {
    // 1 October 2026 is a Thursday: three blanks (Mo, Tu, We).
    const cells = monthGrid(2026, 9);
    expect(cells.slice(0, 4)).toEqual([null, null, null, '2026-10-01']);
    expect(cells.at(-1)).toBe('2026-10-31');
  });

  it('knows February in a leap year', () => {
    expect(monthGrid(2028, 1).at(-1)).toBe('2028-02-29');
  });
});

describe('CalendarPopover', () => {
  it('reports the clicked day as a local ISO date, and moves between months', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 30, 23, 30)); // late on 30 Dec, local
    const onPick = vi.fn();
    render(<CalendarPopover onPick={onPick} onClose={() => {}} />);

    expect(screen.getByText('December 2026')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-date-next'));
    expect(screen.getByText('January 2027')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Friday, January 15, 2027' }));
    expect(onPick).toHaveBeenCalledWith('2027-01-15');
  });

  it('closes on Escape and on an outside click, but not on its opener', () => {
    const onClose = vi.fn();
    const opener = createRef<HTMLButtonElement>();
    render(
      <div>
        <button ref={opener}>opener</button>
        <p>elsewhere</p>
        <CalendarPopover onPick={() => {}} onClose={onClose} ignoreOutside={opener} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId('onboarding-date-popover'));
    fireEvent.mouseDown(screen.getByText('opener'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
