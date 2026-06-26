import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PennyPlanningLoader from '@/components/PennyPlanningLoader';

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

describe('PennyPlanningLoader', () => {
  it('renders the planning copy line', () => {
    render(<PennyPlanningLoader />);
    expect(screen.getByText(/mapping your route and finding fuel/i)).toBeInTheDocument();
  });

  it('keeps the 3-dot indicator alongside the video', () => {
    const { container } = render(<PennyPlanningLoader />);
    expect(container.querySelectorAll('.typing-indicator-dot')).toHaveLength(3);
  });

  it('renders the dog-fetch video by default (non-reduced-motion)', () => {
    const { container } = render(<PennyPlanningLoader />);
    const video = container.querySelector('video.penny-planning-media');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('loop');
    expect(video?.getAttribute('src')).toMatch(/penny-planning\.mp4$/);
  });

  it('degrades to copy + dots when the media asset fails to load', () => {
    const { container } = render(<PennyPlanningLoader />);
    const video = container.querySelector('video.penny-planning-media');
    expect(video).not.toBeNull();
    fireEvent.error(video!);
    // No media element remains, but copy + dots still do.
    expect(container.querySelector('.penny-planning-media')).toBeNull();
    expect(screen.getByText(/mapping your route and finding fuel/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.typing-indicator-dot')).toHaveLength(3);
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
    const { container } = render(<PennyPlanningLoader />);
    expect(container.querySelector('video.penny-planning-media')).toBeNull();
    const img = container.querySelector('img.penny-planning-media');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/penny-planning\.jpg$/);
  });
});
