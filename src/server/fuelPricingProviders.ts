import 'server-only';

/**
 * Build the configured price providers from server env. Returns an empty array
 * when nothing is configured — pricing then degrades gracefully to "unknown" /
 * "unavailable_in_country" and Finn's selection falls back to distance.
 *
 * Env:
 *  - `TANKERKOENIG_API_KEY` — free Germany feed key (selection-grade, `bulk`).
 *  - Google key (via `googleMapsApiKeyForServer`) — `fuelOptions` fallback.
 */
import {
  createGoogleFuelOptionsProvider,
  createTankerkoenigProvider,
  type PriceProvider,
} from '@/lib/fuelPricing';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';

export function buildPriceProviders(): PriceProvider[] {
  const providers: PriceProvider[] = [];

  const tkKey = process.env.TANKERKOENIG_API_KEY?.trim();
  if (tkKey) providers.push(createTankerkoenigProvider(tkKey));

  const googleKey = googleMapsApiKeyForServer();
  if (googleKey) providers.push(createGoogleFuelOptionsProvider(googleKey));

  return providers;
}

/** Just the bulk (selection-grade) providers — cheap enough to price every candidate. */
export function buildBulkPriceProviders(): PriceProvider[] {
  return buildPriceProviders().filter((p) => p.mode === 'bulk');
}
