/**
 * Finn — the fuel-stop + pricing engine. Deterministic core that finds, places,
 * and (later) prices fuel stops along a route. See `docs/design/finn-fuel-agent.md`.
 *
 * Build-alongside note: this module is being assembled next to the existing
 * Google-Places planner (`src/server/fuel.ts`). The continuous-drive tank math
 * (`fuelTankState.ts`) is re-exported here so callers can depend on `@/lib/finn`
 * today; the file is physically relocated into Finn at teardown/cutover.
 */

export * from './range';
export * from './route';
export * from './stationFilter';
export * from './plan';

// Tank-state math — relocated by reference until the teardown moves the file in.
export {
  kmBurnedSinceLastRefuel,
  type LegFuelHistory,
} from '@/lib/penny/fuelTankState';
