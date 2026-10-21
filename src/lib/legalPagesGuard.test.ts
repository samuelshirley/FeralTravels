import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The legal pages say what App Review checks for, and the app can reach them.
 *
 * Four rejections this holds shut (all found in the 2026-10-20 review pass):
 *
 *  - 3.1.2(c), "functional Terms of Use": /terms said "The service is currently
 *    free", with no word on renewal, cancellation or refunds, for an app that
 *    sells an auto-renewing subscription. A reviewer reads the page next to the
 *    purchase sheet; a contradiction between them is the rejection.
 *  - 5.1.1(i) / 5.1.2(i): /privacy has to name every third party that receives
 *    personal data. RevenueCat and Apple-as-payment-processor were missing.
 *    The structural half of this test is the dependency registry below: every
 *    runtime dependency of the web app AND the iOS app has to be classified,
 *    so a new SDK cannot arrive without someone deciding whether the policy
 *    has to name it.
 *  - 5.1.1(i), "easily accessible": the policy was reachable in the app only
 *    from the purchase sheet's footer.
 *  - HIG / 4.8: Sign in with Apple drawn BLACK on a near-black card.
 *
 * Pages and mobile files are read as TEXT, never imported — the legal pages
 * are server components and `noMobileImportGuard` forbids `src/` importing
 * from `mobile/`. The e2e spec (`e2e/legal-pages.spec.ts`) proves the same
 * words reach a signed-out visitor; this proves them on every `npm run test`.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * JSX source → roughly the words a reader sees: entities decoded, tags and
 * `{' '}` spacers dropped, whitespace collapsed. Enough to assert on sentences
 * that are wrapped across source lines.
 */
function visibleText(tsx: string): string {
  return tsx
    .replace(/\{\s*' '\s*\}/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

const termsSource = read('src/app/(legal)/terms/page.tsx');
const terms = visibleText(termsSource);
const privacySource = read('src/app/(legal)/privacy/page.tsx');
const privacy = visibleText(privacySource);

/**
 * The "Who else sees it" list, as source, so a provider counts only when it has
 * its own bolded entry there. A bare substring match over the whole page let a
 * deleted RevenueCat entry pass, because the deletion section still mentions
 * RevenueCat in passing — found by mutation-checking this file.
 */
const recipients = (() => {
  const start = privacySource.indexOf('<h2>Who else sees it</h2>');
  const end = privacySource.indexOf('<h2>', start + 1);
  return start >= 0 && end > start ? privacySource.slice(start, end) : '';
})();
const namesRecipient = (provider: string) =>
  new RegExp(`<li>\\s*<strong>${provider}\\b`).test(recipients);

describe('/terms is the app’s Terms of Use (3.1.2(c))', () => {
  it('is titled Terms of Use, the name the listing and the purchase sheet use', () => {
    expect(termsSource).toContain('<h1>Terms of Use</h1>');
    expect(termsSource).toMatch(/title: 'Terms of Use — Feral Travels'/);
  });

  // Each sentence is one Apple names for an auto-renewable subscription, or a
  // fact the code makes true (see the header comment on the page itself).
  const REQUIRED: Array<[string, RegExp]> = [
    ['7 days free from sign-up', /7 days of free access from the day it is created/],
    ['no payment taken for the free access', /No payment is taken/],
    ['monthly or annual', /subscription, monthly or annual/],
    ['sold through the App Store at the price shown', /sold through Apple's App Store, at the price the app shows/],
    ['charged to the Apple Account at confirmation', /charged to your Apple Account when you confirm the purchase/],
    ['auto-renews unless cancelled 24h before', /renews automatically .* unless you cancel at least 24 hours before the current period ends/],
    ['manage and cancel in Apple Account settings', /manage and cancel it in your Apple Account settings/],
    ['refunds are Apple’s', /Refunds are handled by Apple, under Apple's policies/],
    ['deletion is in-app', /Settings → Delete account/],
    ['deletion is immediate and irreversible', /immediate and cannot be undone/],
    ['deletion does not cancel the subscription', /Deleting your account does not cancel the subscription/],
  ];
  for (const [what, pattern] of REQUIRED) {
    it(`says: ${what}`, () => {
      expect(terms).toMatch(pattern);
    });
  }

  it("links Apple's standard EULA", () => {
    expect(termsSource).toContain(
      'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
    );
  });

  it('no longer contradicts the subscription or the in-app deletion', () => {
    expect(terms).not.toMatch(/currently free/i);
    expect(terms).not.toMatch(/ask for your account and data to be deleted/i);
  });
});

/**
 * Every runtime dependency, classified. `named` is the provider the privacy
 * policy must name because the dependency sends personal data to it; `local`
 * means nothing leaves the device or our own server through it.
 *
 * A dependency missing from here FAILS the suite. That is the point: adding an
 * analytics or crash SDK must be a decision about the policy, not a surprise
 * in a review.
 */
const DEPENDENCIES: Record<string, { named: string } | { local: string }> = {
  // web / server — package.json
  '@anthropic-ai/sdk': { named: 'Anthropic' },
  '@auth/drizzle-adapter': { local: 'stores sessions in our own database' },
  '@googlemaps/js-api-loader': { named: 'Google' },
  '@phosphor-icons/react': { local: 'icons, bundled' },
  '@tmcw/togeojson': { local: 'file parsing, in-process' },
  '@vercel/analytics': { named: 'Vercel' },
  '@xmldom/xmldom': { local: 'XML parsing, in-process' },
  'drizzle-orm': { local: 'query builder for our own database' },
  jose: { local: 'JWT verification, in-process' },
  next: { local: 'the framework' },
  'next-auth': { local: 'auth library; the providers it talks to are named below' },
  postgres: { named: 'Neon' },
  react: { local: 'UI' },
  'react-dom': { local: 'UI' },
  'react-resizable-panels': { local: 'UI' },
  resend: { named: 'Resend' },
  'server-only': { local: 'build-time marker' },
  zod: { local: 'validation' },
  // iOS — mobile/package.json
  '@expo-google-fonts/inter': { local: 'fonts, bundled into the binary' },
  expo: { named: 'Expo' },
  'expo-apple-authentication': { named: 'Apple' },
  'expo-auth-session': { named: 'Google' },
  'expo-constants': { local: 'build constants' },
  'expo-crypto': { local: 'PKCE, on device' },
  'expo-font': { local: 'font loading' },
  'expo-image-picker': { local: 'picks a photo; sending it is Penny, named as Anthropic' },
  'expo-linking': { local: 'opens URLs' },
  'expo-location': { named: 'Apple' },
  'expo-router': { local: 'navigation' },
  'expo-secure-store': { local: 'keychain, on device' },
  'expo-splash-screen': { local: 'UI' },
  'expo-status-bar': { local: 'UI' },
  'expo-updates': { named: 'Expo' },
  'expo-video': { local: 'plays a bundled video' },
  'expo-web-browser': { local: 'opens the system browser' },
  'phosphor-react-native': { local: 'icons, bundled' },
  'react-native': { local: 'the framework' },
  'react-native-maps': { named: 'Apple' },
  'react-native-purchases': { named: 'RevenueCat' },
  'react-native-safe-area-context': { local: 'UI' },
  'react-native-screens': { local: 'UI' },
  'react-native-sse': { local: 'streams from our own server' },
  'react-native-svg': { local: 'UI' },
};

/**
 * Third parties reached by plain `fetch` rather than through an SDK, so the
 * dependency list cannot see them. If the host is in the source, the provider
 * must be on the page.
 */
const HOSTS: Record<string, string> = {
  'nominatim.openstreetmap.org': 'OpenStreetMap',
  'places.googleapis.com': 'Google',
  'maps.googleapis.com': 'Google',
  'oauth2.googleapis.com': 'Google',
  'appleid.apple.com': 'Apple',
};

function runtimeDeps(rel: string): string[] {
  const pkg = JSON.parse(read(rel)) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {});
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) out.push(rel);
  }
  return out;
}

describe('/privacy names every third party that receives personal data (5.1.1(i), 5.1.2(i))', () => {
  const deps = [...runtimeDeps('package.json'), ...runtimeDeps('mobile/package.json')];

  it('finds the "Who else sees it" list', () => {
    expect(recipients).toContain('<ul>');
  });

  it('finds both dependency lists', () => {
    expect(deps).toContain('@anthropic-ai/sdk');
    expect(deps).toContain('react-native-purchases');
  });

  for (const dep of deps) {
    it(`classifies ${dep}`, () => {
      const entry = DEPENDENCIES[dep];
      expect(
        entry,
        `${dep} is a new runtime dependency. Decide whether it sends personal data to a third ` +
          `party; if it does, name that party on /privacy, then classify it in DEPENDENCIES.`,
      ).toBeDefined();
      if (entry && 'named' in entry) {
        expect(
          namesRecipient(entry.named),
          `${dep} sends data to ${entry.named}, and /privacy's "Who else sees it" has no entry for it`,
        ).toBe(true);
      }
    });
  }

  const files = [...sourceFiles('src'), ...sourceFiles('mobile/app'), ...sourceFiles('mobile/lib'), ...sourceFiles('mobile/components')];
  for (const [host, provider] of Object.entries(HOSTS)) {
    it(`names ${provider} if ${host} is called`, () => {
      const used = files.some((f) => read(f).includes(host));
      if (used) expect(namesRecipient(provider), `${host} is called; name ${provider}`).toBe(true);
    });
  }

  it('says what Anthropic receives, and that the app asks first', () => {
    expect(privacy).toMatch(/Anthropic \(Claude\)/);
    expect(privacy).toMatch(/your messages, the photos you attach/);
    expect(privacy).toMatch(/your phone's current position/);
    expect(privacy).toMatch(/The app asks your permission before anything is sent to Anthropic/);
  });

  it('says what RevenueCat receives, and that Apple takes the payment', () => {
    expect(privacy).toMatch(/RevenueCat.*account's ID/);
    expect(privacy).toMatch(/purchase events/);
    expect(privacy).toMatch(/Apple.*takes the payment/);
  });

  it('owns up to the purchase notices that outlive a deletion', () => {
    // subscription_events.user_id is ON DELETE SET NULL and `payload` keeps
    // the store's verbatim event, app_user_id included (schema.ts).
    expect(privacy).toMatch(/Three things outlive the deletion/);
    expect(privacy).toMatch(/Purchase notices/);
  });
});

describe('the legal pages are reachable in the app (5.1.1(i))', () => {
  const links = read('mobile/components/LegalLinks.tsx');
  const settings = read('mobile/app/settings.tsx');
  const signIn = read('mobile/app/sign-in.tsx');

  it('opens the public /privacy and /terms pages', () => {
    expect(links).toMatch(/path: "\/privacy"/);
    expect(links).toMatch(/path: "\/terms"/);
    expect(links).toContain('${API_BASE_URL}${LEGAL_PAGES[page].path}');
  });

  it('carries the testIDs the Maestro flows look for', () => {
    for (const id of ['settings-privacy-link', 'settings-terms-link', 'signin-privacy-link', 'signin-terms-link']) {
      expect(links).toContain(`testID="${id}"`);
    }
  });

  it('is rendered on Settings and on the sign-in screen', () => {
    expect(settings).toMatch(/<LegalSection \/>/);
    expect(signIn).toMatch(/<LegalFooter \/>/);
  });

  it('does not swallow a URL that will not open', () => {
    expect(links).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
    expect(links).toMatch(/notify\(/);
  });
});

describe('Sign in with Apple contrasts with its background (HIG, 4.8)', () => {
  const signIn = read('mobile/app/sign-in.tsx');

  it('is WHITE on the dark sign-in card, never BLACK', () => {
    expect(signIn).toContain('AppleAuthenticationButtonStyle.WHITE');
    expect(signIn).not.toMatch(/AppleAuthenticationButtonStyle\.BLACK\b/);
  });
});
