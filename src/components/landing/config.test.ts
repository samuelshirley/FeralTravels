import { describe, expect, it } from 'vitest';
import { landingVideo } from './config';

const BLOB = 'https://x4hcb3okuf17fqdz.public.blob.vercel-storage.com/hero/v1';

describe('landingVideo', () => {
  it('unset: the committed normal-speed clip, slowed to 0.6x', () => {
    for (const unset of [undefined, '', '   ']) {
      expect(landingVideo(unset)).toEqual({
        sources: [
          { media: '(max-width: 1080px)', src: '/landing/hero-1280.mp4', type: 'video/mp4' },
          { src: '/landing/hero-1920.mp4', type: 'video/mp4' },
        ],
        rate: 0.6,
      });
    }
  });

  it('set: the pre-slowed Blob files at 1x, small screen first, HEVC before h264', () => {
    expect(landingVideo(`${BLOB}/`)).toEqual({
      sources: [
        {
          media: '(max-width: 1080px)',
          src: `${BLOB}/hero-1080p-h264.mp4`,
          type: 'video/mp4; codecs="avc1.640029"',
        },
        { src: `${BLOB}/hero-2160p-hevc.mp4`, type: 'video/mp4; codecs="hvc1.2.4.L150.B0"' },
        { src: `${BLOB}/hero-2160p-h264.mp4`, type: 'video/mp4; codecs="avc1.640033"' },
      ],
      rate: 1,
    });
  });

  it('the trailing slash on the base makes no difference', () => {
    expect(landingVideo(BLOB)).toEqual(landingVideo(`${BLOB}/`));
  });
});
