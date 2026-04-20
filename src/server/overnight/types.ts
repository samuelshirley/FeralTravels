import 'server-only';

export type OvernightSource = 'ioverlander' | 'park4night' | 'google_places';

export type OvernightCategory =
  | 'wild_camping' // free off-grid spot, the gold standard
  | 'rest_area' // highway-side aire / rest area
  | 'aire' // motorhome aire (often free in EU)
  | 'parking' // generic free parking lot tolerated overnight
  | 'dog_park' // park with a parking lot — frequently a quiet spot
  | 'other';

export interface OvernightSpot {
  id?: number; // db id, present when persisted
  source: OvernightSource;
  sourceId: string | null;
  name: string;
  lat: number;
  lng: number;
  category: OvernightCategory;
  isFree: boolean;
  description: string | null;
  sourceUrl: string | null;
  /** Distance in km from query origin, populated by orchestrator. */
  distanceKm?: number;
  /** Drive time in minutes from query origin if computed. */
  driveTimeMinutes?: number;
}

export interface FindSpotsInput {
  /** Query center (origin or candidate end-of-day point). */
  lat: number;
  lng: number;
  /** Search radius in km. */
  radiusKm: number;
  /** Soft cap on rows returned per source. */
  perSourceLimit?: number;
  /** Filter out paid campgrounds, hotels, anything that isn't free overnight parking. */
  freeOnly?: boolean;
}
