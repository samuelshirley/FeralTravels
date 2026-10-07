/**
 * PaneLock keeps a pane VISIBLE and takes it out of the application: inert
 * (or aria-hidden where inert is missing), no pointer events, and a scrim on
 * top carrying whatever notice the caller passes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PaneLock from './PaneLock';

afterEach(() => cleanup());

function contentWrapper(): HTMLElement {
  return screen.getByRole('button', { name: 'Open day 1', hidden: true }).parentElement as HTMLElement;
}

function isBlockedFromAT(el: HTMLElement): boolean {
  return el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true';
}

describe('PaneLock', () => {
  it('unlocked: the pane is fully live, with no scrim', () => {
    const onClick = vi.fn();
    render(
      <PaneLock locked={false} notice={<p>Paused</p>}>
        <button onClick={onClick}>Open day 1</button>
      </PaneLock>
    );
    expect(screen.queryByTestId('pane-lock-scrim')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(isBlockedFromAT(contentWrapper())).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open day 1' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('locked: the content stays rendered but is inert, and the scrim carries the notice', () => {
    render(
      <PaneLock locked notice={<p>Your trip is paused</p>}>
        <button>Open day 1</button>
      </PaneLock>
    );
    // Still in the DOM — covered, not deleted.
    expect(screen.getByText('Open day 1')).toBeInTheDocument();
    const wrapper = contentWrapper();
    expect(isBlockedFromAT(wrapper)).toBe(true);
    expect(wrapper.style.pointerEvents).toBe('none');
    const scrim = screen.getByTestId('pane-lock-scrim');
    expect(scrim).toHaveTextContent('Your trip is paused');
    // The scrim itself is not inert: it is where the explanation lives.
    expect(scrim.hasAttribute('inert')).toBe(false);
  });

  it('locked with no notice is a bare wash (the map beside a locked list)', () => {
    render(
      <PaneLock locked>
        <button>Open day 1</button>
      </PaneLock>
    );
    const scrim = screen.getByTestId('pane-lock-scrim');
    expect(scrim).toBeEmptyDOMElement();
  });

  it('unlocking restores the pane', () => {
    const { rerender } = render(
      <PaneLock locked notice={<p>Paused</p>}>
        <button>Open day 1</button>
      </PaneLock>
    );
    expect(isBlockedFromAT(contentWrapper())).toBe(true);
    rerender(
      <PaneLock locked={false} notice={<p>Paused</p>}>
        <button>Open day 1</button>
      </PaneLock>
    );
    expect(isBlockedFromAT(contentWrapper())).toBe(false);
    expect(contentWrapper().style.pointerEvents).toBe('');
    expect(screen.queryByTestId('pane-lock-scrim')).not.toBeInTheDocument();
  });

  it('merges the caller style onto the root, the box the scrim is positioned against', () => {
    const { container } = render(
      <PaneLock locked style={{ position: 'absolute', top: 0, display: 'none' }}>
        <span>x</span>
      </PaneLock>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.position).toBe('absolute');
    expect(root.style.display).toBe('none');
    expect(root).toContainElement(screen.getByTestId('pane-lock-scrim'));
  });
});
