import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
// PennyPlanningLoader is now a thin re-export of PennyPlanningVideo (the clip is
// a persistent Penny message, not a transient loader). Test via the re-export so
// this file stays meaningful until it's renamed/removed.
import PennyPlanningVideo from '@/components/PennyPlanningLoader';

// jsdom has no matchMedia — provide a non-reduced-motion stub by default.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // play() isn't implemented in jsdom; make it a resolved no-op.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLMediaElement.prototype as any).play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PennyPlanningVideo', () => {
  it('renders the looping dog-fetch video by default (non-reduced-motion)', () => {
    const { container } = render(<PennyPlanningVideo />);
    const video = container.querySelector('video.penny-planning-media');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('loop');
    expect(video?.getAttribute('src')).toMatch(/penny-planning\.mp4(\?|$)/);
  });

  it('renders nothing when the media asset fails to load (caption stands alone)', () => {
    const { container } = render(<PennyPlanningVideo />);
    const video = container.querySelector('video.penny-planning-media');
    expect(video).not.toBeNull();
    fireEvent.error(video!);
    expect(container.querySelector('.penny-planning-media')).toBeNull();
    expect(container.querySelector('.penny-planning-media-bubble')).toBeNull();
  });

  it('shows a still poster instead of the video under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { container } = render(<PennyPlanningVideo />);
    expect(container.querySelector('video.penny-planning-media')).toBeNull();
    const img = container.querySelector('img.penny-planning-media');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/penny-planning\.jpg(\?|$)/);
  });
});
