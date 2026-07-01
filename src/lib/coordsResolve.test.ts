import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  extractUrlsFromText,
  resolveCoordsFromInput,
  resolveMapsLinksInMessage,
} from './coordsResolve';

describe('extractUrlsFromText', () => {
  it('extracts a URL embedded mid-sentence', () => {
    const msg =
      'overnight spot for 4 days https://maps.app.goo.gl/5jGAMKvapsXd3zWk8 thanks';
    expect(extractUrlsFromText(msg)).toEqual([
      'https://maps.app.goo.gl/5jGAMKvapsXd3zWk8',
    ]);
  });

  it('dedupes and strips trailing punctuation', () => {
    const msg =
      'see https://www.google.com/maps/place/Test/@55.67,12.57,15z, and again https://www.google.com/maps/place/Test/@55.67,12.57,15z.';
    const urls = extractUrlsFromText(msg);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://www.google.com/maps/place/Test/@55.67,12.57,15z');
  });

  it('returns multiple distinct URLs in order', () => {
    const a = 'https://maps.apple.com/?ll=55.67,12.57';
    const b = 'https://www.google.com/maps/@48.85,2.35,17z';
    const urls = extractUrlsFromText(`first ${a} second ${b}`);
    expect(urls).toEqual([a, b]);
  });
});

describe('resolveCoordsFromInput', () => {
  it('parses full Google Maps place URLs without fetch', async () => {
    const url = 'https://www.google.com/maps/place/Copenhagen/@55.6761,12.5683,15z';
    const result = await resolveCoordsFromInput(url);
    expect(result).toMatchObject({
      lat: 55.6761,
      lng: 12.5683,
      source: 'google_maps',
    });
    expect(result?.name).toContain('Copenhagen');
  });

  it('parses Apple Maps URLs without fetch', async () => {
    const url = 'https://maps.apple.com/?ll=55.67,12.57&q=Test+Spot';
    const result = await resolveCoordsFromInput(url);
    expect(result).toMatchObject({
      lat: 55.67,
      lng: 12.57,
      source: 'apple_maps',
      name: 'Test Spot',
    });
  });
});

describe('resolveCoordsFromInput short links', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('follows redirect to canonical Google Maps URL with coords', async () => {
    const short = 'https://maps.app.goo.gl/abc123';
    const canonical =
      'https://www.google.com/maps/place/Denmark+Camp/@56.1234,10.5678,17z';

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: canonical },
      })
    );

    const result = await resolveCoordsFromInput(short);
    expect(result).toMatchObject({
      lat: 56.1234,
      lng: 10.5678,
      source: 'google_maps',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to canonical link in HTML body', async () => {
    const short = 'https://maps.app.goo.gl/xyz789';
    const canonical =
      'https://www.google.com/maps/place/Spot/@57.0,11.0,15z/data=!3d57.0!4d11.0';

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        `<html><head><link rel="canonical" href="${canonical}" /></head></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    );

    const result = await resolveCoordsFromInput(short);
    expect(result).toMatchObject({ lat: 57, lng: 11, source: 'google_maps' });
  });

  it('returns null when short link cannot be resolved', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html><body>no coords here</body></html>', { status: 200 })
    );

    const result = await resolveCoordsFromInput('https://maps.app.goo.gl/nope');
    expect(result).toBeNull();
  });
});

describe('resolveCoordsFromInput body scan', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('extracts coords from a !3d!4d blob with no canonical tag', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        '<html><head><title>Spot - Google Maps</title></head><body>data=!3d57.0!4d11.0</body></html>',
        { status: 200 }
      )
    );
    const result = await resolveCoordsFromInput('https://maps.app.goo.gl/bang');
    expect(result).toMatchObject({ lat: 57, lng: 11, source: 'google_maps' });
  });

  it('extracts coords from a bare @lat,lng in the body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html><body>...@56.5,10.2,17z...</body></html>', { status: 200 })
    );
    const result = await resolveCoordsFromInput('https://maps.app.goo.gl/at');
    expect(result).toMatchObject({ lat: 56.5, lng: 10.2 });
  });

  it('geocodes the page name when the page has no coords', async () => {
    const prevKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = 'test-key';
    try {
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('maps.app.goo.gl')) {
          return new Response(
            '<html><head><meta property="og:title" content="Clean Kokos - Google Maps"></head><body>no coords</body></html>',
            { status: 200 }
          );
        }
        if (url.includes('places.googleapis.com')) {
          return new Response(
            JSON.stringify({
              places: [
                {
                  location: { latitude: 60.39, longitude: 5.32 },
                  displayName: { text: 'Clean Kokos' },
                  formattedAddress: 'Bergen, Norway',
                  types: ['establishment'],
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('', { status: 404 });
      });

      const result = await resolveCoordsFromInput('https://maps.app.goo.gl/named');
      expect(result).toMatchObject({ lat: 60.39, lng: 5.32, name: 'Clean Kokos' });
    } finally {
      if (prevKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = prevKey;
    }
  });
});

describe('resolveMapsLinksInMessage', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('resolves maps links and ignores non-maps URLs', async () => {
    const mapsUrl = 'https://www.google.com/maps/@48.85,2.35,17z';
    const msg = `go here ${mapsUrl} and read https://example.com/not-maps`;

    const results = await resolveMapsLinksInMessage(msg);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: mapsUrl,
      resolved: true,
      lat: 48.85,
      lng: 2.35,
    });
  });

  it('returns resolved:false when short link expansion fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('', { status: 404 })
    );

    const url = 'https://maps.app.goo.gl/fail';
    const results = await resolveMapsLinksInMessage(`stay here ${url}`);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url,
      resolved: false,
      error: expect.stringContaining('Could not resolve'),
    });
  });

  it('caps at five maps links per message', async () => {
    const links = Array.from(
      { length: 7 },
      (_, i) => `https://www.google.com/maps/@${48 + i}.0,2.0,17z`
    );
    const msg = links.join(' ');
    const results = await resolveMapsLinksInMessage(msg);
    expect(results).toHaveLength(5);
  });
});
