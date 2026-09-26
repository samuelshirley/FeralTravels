import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import HeroVideo from './HeroVideo';
import { landingVideo, pickSources } from './config';

/**
 * iPhones played the DESKTOP hero file: WebKit reads `<source media>` as not
 * matching on a <video> that React builds detached and then inserts. So the
 * sources are picked with matchMedia and rendered with no `media` attribute.
 * These pin which file each screen gets, not how the browser would choose.
 */

const BLOB = 'https://x4hcb3okuf17fqdz.public.blob.vercel-storage.com/hero/v1';

/** A screen `width` px wide; `reduce` is the Reduce Motion setting. */
function stubScreen(width: number, reduce = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const max = /\(max-width:\s*(\d+)px\)/.exec(query);
      const matches = query.includes('prefers-reduced-motion')
        ? reduce
        : max
          ? width <= Number(max[1])
          : false;
      return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    }),
  );
}

async function renderedSources() {
  const { container } = render(<HeroVideo className="hero" />);
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  return [...container.querySelectorAll('video source')];
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLMediaElement.prototype as any).play = vi.fn().mockResolvedValue(undefined);
  // jsdom logs "not implemented" for media loading; the tests read the DOM only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLMediaElement.prototype as any).load = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HeroVideo source choice', () => {
  it('a phone-width screen gets the phone file first', async () => {
    stubScreen(390);
    const sources = await renderedSources();
    expect(sources.map((s) => s.getAttribute('src'))).toEqual([
      '/landing/hero-1280.mp4',
      '/landing/hero-1920.mp4',
    ]);
  });

  it('a desktop screen gets the desktop file, never the phone one', async () => {
    stubScreen(1440);
    const sources = await renderedSources();
    expect(sources.map((s) => s.getAttribute('src'))).toEqual(['/landing/hero-1920.mp4']);
  });

  it('no <source> carries a media attribute for WebKit to misread', async () => {
    stubScreen(390);
    const sources = await renderedSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) expect(s.hasAttribute('media')).toBe(false);
  });

  it('Reduce Motion renders no video at all', async () => {
    stubScreen(390, true);
    const { container } = render(<HeroVideo className="hero" />);
    // Let the mount effect run before asserting there is still nothing.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('pickSources (Blob)', () => {
  const blob = landingVideo(BLOB);

  it('phone: the phone h264 first, then HEVC before h264', () => {
    expect(pickSources(blob, () => true).map((s) => s.src)).toEqual([
      `${BLOB}/hero-1080p-h264.mp4`,
      `${BLOB}/hero-2160p-hevc.mp4`,
      `${BLOB}/hero-2160p-h264.mp4`,
    ]);
  });

  it('desktop: HEVC before h264, codecs kept so a non-HEVC browser skips it', () => {
    expect(pickSources(blob, () => false)).toEqual([
      { src: `${BLOB}/hero-2160p-hevc.mp4`, type: 'video/mp4; codecs="hvc1.2.4.L150.B0"' },
      { src: `${BLOB}/hero-2160p-h264.mp4`, type: 'video/mp4; codecs="avc1.640033"' },
    ]);
  });
});
