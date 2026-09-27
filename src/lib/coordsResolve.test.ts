import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The geocode fallback goes through `geocodePlaceAccounted`, which writes a
// usage_events row fire-and-forget. Unmocked, that write dialled a real
// Postgres; with none running, its ECONNREFUSED was logged after this file's
// worker had closed, and vitest failed the whole run with
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
// (about 1 run in 16).
vi.mock('@/server/repos/usage', () => ({
  logGoogleApiUsage: vi.fn(async () => {}),
  logGooglePlacesUsage: vi.fn(async () => {}),
  logUsageEvent: vi.fn(async () => {}),
}));

import {
  extractEmbeddedMapsQuery,
  extractUrlsFromText,
  resolveCoordsFromInput,
  resolveMapsLinksInMessage,
} from './coordsResolve';
import { logUsageEvent } from '@/server/repos/usage';

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

// ---------------------------------------------------------------------------
// 2026-09 share links. `https://maps.app.goo.gl/ys3PKbHMPZbQq8o29?g_st=ic`
// (Praça do Comércio, Lisbon) 302s THREE times to an address-only `q=` and
// ends on a page whose only coordinates are in the og:image staticmap. The
// fixture is that page, captured live and trimmed.
// ---------------------------------------------------------------------------

const SHARE_PAGE = readFileSync(join(__dirname, '__fixtures__', 'maps-share-2026-09.html'), 'utf8');
const SHORT = 'https://maps.app.goo.gl/ys3PKbHMPZbQq8o29?g_st=ic';
const TAIL =
  '&ftid=0xd19347a6ca0796f:0xc5fa8d0ee58ee54&entry=gps&shh=CAE&skid=c876bf6e-a386-4a4d-b596-011eb77c8e4d&g_st=ic';
const Q = 'Pra%C3%A7a+do+Com%C3%A9rcio+2-113,+1100-148,+Portugal';
const HOP1 = `https://maps.google.com?q=${Q}${TAIL}`;
const HOP2 = `https://maps.google.com/maps?q=${Q}${TAIL}`;
const HOP3 = `https://www.google.com/maps?q=${Q}${TAIL}`;
const CLEAN_Q = 'Praça do Comércio 2-113, 1100-148, Portugal';

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Serve the real 3-hop chain, then `page` as the final 200; anything else via `extra`. */
function shareChain(page: string, extra: Handler = () => undefined) {
  const places: Array<{ textQuery: string }> = [];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The resolver normalises each Location through URL (`maps.google.com?q=`
    // becomes `maps.google.com/?q=`), so compare normalised forms.
    const url = new URL(String(input)).toString();
    const same = (a: string) => url === new URL(a).toString();
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    if (same(SHORT)) return redirect(HOP1);
    if (same(HOP1)) return redirect(HOP2);
    if (same(HOP2)) return redirect(HOP3);
    if (same(HOP3)) return new Response(page, { status: 200 });
    if (url.includes('places.googleapis.com')) {
      places.push(JSON.parse(String(init?.body)) as { textQuery: string });
    }
    return extra(url, init) ?? new Response(JSON.stringify({ places: [] }), { status: 200 });
  });
  return places;
}

/** The fixture with every staticmap URL (attribute and JSON copies) removed. */
const withoutStaticmap = (html: string) =>
  html.replace(/https:\/\/maps\.google\.com\/maps\/api\/staticmap\?[^"]*/g, '');

describe('2026-09 share links (address-only q= redirect chain)', () => {
  const originalFetch = globalThis.fetch;
  let prevKey: string | undefined;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(logUsageEvent).mockClear();
    prevKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    if (prevKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = prevKey;
  });

  it('resolves the real chain from the staticmap pin, with zero Places calls', async () => {
    const places = shareChain(SHARE_PAGE);
    const result = await resolveCoordsFromInput(SHORT);
    expect(result).toMatchObject({ lat: 38.7069975, lng: -9.1356866, name: 'Praça do Comércio 2-113' });
    expect(places).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('never reads APP_INITIALIZATION_STATE (the viewer\'s viewport, Girona) as the place', async () => {
    shareChain(SHARE_PAGE);
    const result = await resolveCoordsFromInput(SHORT);
    expect(result?.lat).not.toBeCloseTo(41.975808, 2);
    expect(result?.lng).not.toBeCloseTo(2.8278784, 2);
  });

  it('without the staticmap, geocodes exactly once with the clean redirect q=', async () => {
    const places = shareChain(withoutStaticmap(SHARE_PAGE), (url) =>
      url.includes('places.googleapis.com')
        ? new Response(
            JSON.stringify({
              places: [
                {
                  location: { latitude: 38.70701, longitude: -9.13568 },
                  displayName: { text: 'Some Business At That Address' },
                  types: ['establishment'],
                },
              ],
            }),
            { status: 200 },
          )
        : undefined,
    );
    const links = await resolveMapsLinksInMessage(`Add this overnight location for my stop in Lisbon ${SHORT}`, {
      userId: 'u1',
      tripId: 't1',
    });
    expect(places).toEqual([{ textQuery: CLEAN_Q }]);
    // The shared name (og:title) is kept, not Places' label.
    expect(links[0]).toMatchObject({ resolved: true, lat: 38.70701, lng: -9.13568, name: 'Praça do Comércio 2-113' });
    expect(logUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'penny:maps-link',
        success: true,
        userId: 'u1',
        tripId: 't1',
        errorMessage: expect.stringContaining('via=geocode'),
      }),
    );
  });

  it('decodes the double-encoded, non-ASCII embedded link', () => {
    expect(extractEmbeddedMapsQuery(SHARE_PAGE)).toBe(CLEAN_Q);
  });

  it('decodes HTML entities in a content-first og:title', async () => {
    const page = SHARE_PAGE.replace(
      '<meta content="Praça do Comércio 2-113" property="og:title">',
      '<meta content="Caf&#233; &amp; Bar O&#39;Neill" property="og:title">',
    );
    shareChain(page);
    const result = await resolveCoordsFromInput(SHORT);
    expect(result?.name).toBe("Café & Bar O'Neill");
  });

  it('reads a unicode-escaped staticmap center= when that is the only pin', async () => {
    const page =
      '<html><head><title>Google Maps</title></head><body><script>var d=["https://maps.google.com/maps/api/staticmap?center\\u003d38.7069975%2C-9.1356866\\u0026zoom\\u003d16"];</script></body></html>';
    const places = shareChain(page);
    const result = await resolveCoordsFromInput(SHORT);
    expect(result).toMatchObject({ lat: 38.7069975, lng: -9.1356866 });
    expect(places).toHaveLength(0);
  });

  it('reads a styled markers= pin (color:red%7C prefix)', async () => {
    const page =
      '<meta content="https://maps.google.com/maps/api/staticmap?zoom=16&amp;markers=color:red%7Clabel:A%7C38.7069975,-9.1356866" property="og:image">';
    shareChain(page);
    expect(await resolveCoordsFromInput(SHORT)).toMatchObject({ lat: 38.7069975, lng: -9.1356866 });
  });

  it('never geocodes a bare "Google Maps" title', async () => {
    const page =
      '<html><head><title> Google Maps </title><meta content="Google Maps" property="og:title"></head><body></body></html>';
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('places.googleapis.com')
        ? new Response(JSON.stringify({ places: [] }), { status: 200 })
        : new Response(page, { status: 200 }),
    );
    const links = await resolveMapsLinksInMessage('https://maps.app.goo.gl/bare');
    const placesCalls = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('places.googleapis.com'));
    expect(placesCalls).toHaveLength(0);
    expect(links[0]).toMatchObject({ resolved: false, stage: 'no_coords' });
    expect(links[0].name_hint).toBeUndefined();
  });

  it('ignores the viewport alone — a page with only APP_INITIALIZATION_STATE is a miss', async () => {
    const page =
      '<html><head><title> Google Maps </title></head><body><script>window.APP_INITIALIZATION_STATE=[[[23729.117755998923,2.8278784,41.975808],[0,0,0],[1024,768],13.1]];</script></body></html>';
    vi.mocked(fetch).mockResolvedValue(new Response(page, { status: 200 }));
    expect(await resolveCoordsFromInput('https://maps.app.goo.gl/viewport')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a miss writes a penny:maps-link usage row and hands Penny a name_hint', async () => {
    // No coords anywhere, and Places finds nothing for any candidate.
    const places = shareChain(withoutStaticmap(SHARE_PAGE));
    const links = await resolveMapsLinksInMessage(`stop here ${SHORT}`, { userId: 'u1', tripId: 't1' });
    // hint, embedded q and og:description are one string after dedupe; og:title is the second.
    expect(places).toEqual([{ textQuery: CLEAN_Q }, { textQuery: 'Praça do Comércio 2-113' }]);
    expect(links[0]).toMatchObject({
      url: SHORT,
      resolved: false,
      stage: 'geocode_miss',
      name_hint: 'Praça do Comércio 2-113',
    });
    expect(logUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'penny:maps-link',
        requests: 0,
        success: false,
        userId: 'u1',
        tripId: 't1',
        errorMessage: expect.stringMatching(/^stage=geocode_miss host=maps\.app\.goo\.gl hops=3 hint=yes .*url=https:\/\/maps\.app\.goo\.gl\//),
      }),
    );
  });

  it('a fetch failure is logged with its message, not swallowed', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValue(new Error('socket hang up'));
    const links = await resolveMapsLinksInMessage('https://maps.app.goo.gl/down');
    expect(links[0]).toMatchObject({ resolved: false, stage: 'fetch_error' });
    expect(logUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: expect.stringContaining('socket hang up') }),
    );
    warn.mockRestore();
  });
});
