// DEPRECATED: This modal has been removed. Users should ask Penny for stop suggestions instead.
// This file can be safely deleted.

export interface NearbyStopSuggestion {
  name: string;
  lat: number;
  lng: number;
  distance_km: number;
  google_maps_uri: string;
  place_id?: string;
}

export interface MoreStopsData {
  fuel: NearbyStopSuggestion[];
  groceries: NearbyStopSuggestion[];
  water: NearbyStopSuggestion[];
  parks: NearbyStopSuggestion[];
}

export type SearchMode = 'along-route' | 'near-destination';

export interface MoreStopsModalProps {
  isOpen: boolean;
  onClose: () => void;
  legLabel: string;
  stops: MoreStopsData;
  loading: boolean;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
}

export default function MoreStopsModal(_props: MoreStopsModalProps) {
  return null;
}
