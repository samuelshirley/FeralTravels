import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  extractEmbeddedMapsQuery,
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

describe('extractEmbeddedMapsQuery', () => {
  it('decodes the q= address from a real app-link interstitial link', () => {
    // Exact encoded shape Google serves to a crawler UA for maps.app.goo.gl.
    const html =
      '<a href="https://www.google.com/maps%3Fq%3DSaupstad%2BHundepark%2B(kommunal),%2BKongsvegen%2B132,%2B7088%2BHeimdal,%2BNorway%26ftid%3D0x466d2e77ba90cea3:0xa9f54e52147a50f4%26entry%3Dgps">open</a>';
    expect(extractEmbeddedMapsQuery(html)).toBe(
      'Saupstad Hundepark (kommunal), Kongsvegen 132, 7088 Heimdal, Norway'
    );
  });

  it('returns null when no embedded maps link is present', () => {
    expect(extractEmbeddedMapsQuery('<html><body>nothing here</body></html>')).toBeNull();
  });
});

describe('resolveCoordsFromInput app-link interstitial', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.stubGlobal('fetch', originalFetch));

  it('resolves a maps.app.goo.gl interstitial by geocoding the embedded q= address', async () => {
    const prevKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = 'test-key';
    try {
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('maps.app.goo.gl')) {
          // Crawler-UA interstitial: no coords, no og:title — only the encoded link.
          return new Response(
            '<!doctype html><html><head><link rel="canonical" href="https://maps.app.goo.gl/abc"></head><body>' +
              '<a href="https://www.google.com/maps%3Fq%3DSaupstad%2BHundepark%2B(kommunal),%2BKongsvegen%2B132,%2B7088%2BHeimdal,%2BNorway%26ftid%3D0x466d2e77ba90cea3:0xa9f54e52147a50f4%26entry%3Dgps">open</a>' +
              '</body></html>',
            { status: 200 }
          );
        }
        if (url.includes('places.googleapis.com')) {
          return new Response(
            JSON.stringify({
              places: [
                {
                  location: { latitude: 63.3456, longitude: 10.3701 },
                  displayName: { text: 'Saupstad Hundepark' },
                  formattedAddress: 'Kongsvegen 132, 7088 Heimdal, Norway',
                  types: ['park', 'point_of_interest'],
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('', { status: 404 });
      });

      const result = await resolveCoordsFromInput('https://maps.app.goo.gl/8C3LKU9kAJDxpvAt8?g_st=ic');
      expect(result).toMatchObject({
        lat: 63.3456,
        lng: 10.3701,
        name: 'Saupstad Hundepark',
        source: 'google_maps',
      });
    } finally {
      if (prevKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = prevKey;
    }
  });

  it('fetches short links with a crawler User-Agent (a browser UA gets a JS-only page)', async () => {
    let capturedUA = '';
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedUA = headers['user-agent'] ?? '';
      return new Response('<html><body>no coords</body></html>', { status: 200 });
    });

    await resolveCoordsFromInput('https://maps.app.goo.gl/whatever');
    expect(capturedUA.toLowerCase()).toContain('facebookexternalhit');
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
