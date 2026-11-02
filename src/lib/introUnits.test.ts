import { describe, expect, it } from 'vitest';
import { introUnitsForLocale, localeRegion } from './introUnits';

describe('localeRegion', () => {
  it.each([
    ['en-US', 'US'],
    ['en_US', 'US'],
    ['es-ES', 'ES'],
    ['en-GB', 'GB'],
    ['zh-Hant-TW', 'TW'],
    ['es-419', '419'],
    ['en-US-u-rg-gbzzzz', 'GB'],
    ['en-GB-u-ca-gregory-rg-uszzzz', 'US'],
    ['de-DE-u-co-phonebk', 'DE'],
    ['my-MM', 'MM'],
    ['en-LR', 'LR'],
  ])('%s -> %s', (locale, region) => {
    expect(localeRegion(locale)).toBe(region);
  });

  it.each([['en'], ['es'], [''], [null], [undefined], ['en-x-private'], ['zh-Hant']])(
    'no region in %s',
    (locale) => {
      expect(localeRegion(locale)).toBeNull();
    }
  );
});

describe('introUnitsForLocale', () => {
  it.each(['en-US', 'es-US', 'en-LR', 'my-MM', 'en-GB-u-rg-uszzzz'])('%s -> imperial', (l) => {
    expect(introUnitsForLocale(l)).toBe('imperial');
  });

  it.each(['en-GB', 'es-ES', 'fr-FR', 'en-CA', 'en-AU', 'en-US-u-rg-eszzzz', 'en', '', null, undefined])(
    '%s -> metric',
    (l) => {
      expect(introUnitsForLocale(l)).toBe('metric');
    }
  );
});
