import { describe, expect, it } from 'vitest';
import { landingVideo } from './config';

const BLOB = 'https://x4hcb3okuf17fqdz.public.blob.vercel-storage.com/hero/v1';

describe('landingVideo', () => {
  it('unset: exactly the two committed /landing/ files, small screen first', () => {
    for (const unset of [undefined, '', '   ']) {
      expect(landingVideo(unset).sources).toEqual([
        { media: '(max-width: 1080px)', src: '/landing/hero-1280.mp4', type: 'video/mp4' },
        { src: '/landing/hero-1920.mp4', type: 'video/mp4' },
      ]);
    }
  });

  it('set: the Blob files, small screen first, HEVC before h264', () => {
    expect(landingVideo(`${BLOB}/`).sources).toEqual([
      {
        media: '(max-width: 1080px)',
        src: `${BLOB}/hero-1080p-h264.mp4`,
        type: 'video/mp4; codecs="avc1.640029"',
      },
      { src: `${BLOB}/hero-2160p-hevc.mp4`, type: 'video/mp4; codecs="hvc1.2.4.L150.B0"' },
      { src: `${BLOB}/hero-2160p-h264.mp4`, type: 'video/mp4; codecs="avc1.640033"' },
    ]);
  });

  // Both copies are the same loop, already slowed to 0.6x. Any other rate
  // slows it twice (0.36x) or speeds Penny past the pace she was cut at.
  it('both sources are pre-slowed, so both play at 1x', () => {
    expect(landingVideo(undefined).rate).toBe(1);
    expect(landingVideo(BLOB).rate).toBe(1);
  });

  it('the trailing slash on the base makes no difference', () => {
    expect(landingVideo(BLOB)).toEqual(landingVideo(`${BLOB}/`));
  });
});
