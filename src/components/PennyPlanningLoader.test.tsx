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

  /**
   * The frozen-clip bug (2026-09-08). Both platforms pause the clip when the
   * app/tab goes away and neither restarts it: expo-video's
   * `onAppForegrounded()` is an empty function, and `autoPlay` is a load-time
   * attribute that never fires twice. During a 2-4 minute planning turn the
   * clip is the only thing on screen saying Penny is still working, so a clip
   * that comes back frozen reads as an app that has died.
   *
   * Asserts the RESUME, not the listener: `play()` is called again after the
   * page reports itself visible, and only when the element is actually paused.
   */
  describe('resumes when the page comes back', () => {
    /** jsdom's visibilityState is read-only; redefine it per test. */
    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
    };

    it('plays again on visibilitychange after the tab was hidden', () => {
      const { container } = render(<PennyPlanningVideo />);
      const video = container.querySelector('video.penny-planning-media') as HTMLVideoElement;
      expect(video).not.toBeNull();

      // jsdom never actually plays, so `paused` is always true — which is the
      // state this effect is for. Clear the mount-time call and come back.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const play = (HTMLMediaElement.prototype as any).play as ReturnType<typeof vi.fn>;
      play.mockClear();

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(play).not.toHaveBeenCalled();

      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(play).toHaveBeenCalledTimes(1);
    });

    it('does not restart the clip under reduced motion', () => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
          matches: true,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      render(<PennyPlanningVideo />);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const play = (HTMLMediaElement.prototype as any).play as ReturnType<typeof vi.fn>;
      play.mockClear();
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      expect(play).not.toHaveBeenCalled();
    });

    it('leaves an already-playing clip alone', () => {
      const { container } = render(<PennyPlanningVideo />);
      const video = container.querySelector('video.penny-planning-media') as HTMLVideoElement;
      Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const play = (HTMLMediaElement.prototype as any).play as ReturnType<typeof vi.fn>;
      play.mockClear();
      setVisibility('visible');
      window.dispatchEvent(new Event('focus'));
      expect(play).not.toHaveBeenCalled();
    });
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
