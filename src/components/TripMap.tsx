'use client';

import { useEffect, useRef, useState } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import type { LegWithDetails, POI } from '@/types/trip';

let optionsConfigured = false;

interface TripMapProps {
  legs: LegWithDetails[];
  pois: POI[];
  selectedLegId: string | null;
  onLegSelect: (legId: string) => void;
  trailsVersion?: number;
  tripId: string;
}

interface GpxFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry:
      | { type: 'LineString'; coordinates: [number, number, number?][] }
      | { type: 'MultiLineString'; coordinates: [number, number, number?][][] }
      | { type: 'Point'; coordinates: [number, number, number?] };
    properties?: Record<string, unknown>;
  }>;
}

/** Warm light basemap aligned with app cream / tan palette */
const LIGHT_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#ebe6dd' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f6f2ea' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5c5c5c' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#d4c9ba' }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#e0d8cc' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#333333' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6b6b6b' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#f0ebe3' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#d4c9ba' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c5d4e0' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e7ab0' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#e2ddd4' }] },
];

function legKey(leg: LegWithDetails): string {
  return `${leg.id}:${leg.start_lat},${leg.start_lng}->${leg.end_lat},${leg.end_lng}`;
}

export default function TripMap({ legs, pois, selectedLegId, onLegSelect, trailsVersion = 0, tripId }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  // directionsServiceRef removed — routes come from stored DB geometry now
  const layersRef = useRef<{
    routePolylines: Map<string, google.maps.Polyline>;
    gapPolylines: google.maps.Polyline[];
    legMarkers: Map<string, google.maps.Marker>;
    finalMarker: google.maps.Marker | null;
    poiMarkers: google.maps.Marker[];
    gpxPolylines: Map<string, google.maps.Polyline[]>;
    fallbackPolyline: google.maps.Polyline | null;
    infoWindow: google.maps.InfoWindow | null;
  }>({
    routePolylines: new Map(),
    gapPolylines: [],
    legMarkers: new Map(),
    finalMarker: null,
    poiMarkers: [],
    gpxPolylines: new Map(),
    fallbackPolyline: null,
    infoWindow: null,
  });

  // Cache fetched routes between renders so we don't re-call Directions every state change
  const routeCacheRef = useRef<Map<string, google.maps.LatLngLiteral[]>>(new Map());
  const [routesVersion, setRoutesVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const onLegSelectRef = useRef(onLegSelect);
  useEffect(() => {
    onLegSelectRef.current = onLegSelect;
  }, [onLegSelect]);

  // One-time Google Maps init
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      setLoadError(
        'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set. Add it to .env and restart npm run dev.'
      );
      return;
    }

    let cancelled = false;
    if (!optionsConfigured) {
      setOptions({ key: apiKey, v: 'weekly' });
      optionsConfigured = true;
    }

    (async () => {
      try {
        const [{ Map: GMap }] = await Promise.all([
          importLibrary('maps'),
        ]);
        if (cancelled || !el.isConnected || mapRef.current) return;

        const map = new GMap(el, {
          center: { lat: 52, lng: 10 },
          zoom: 5,
          styles: LIGHT_MAP_STYLE,
          disableDefaultUI: false,
          zoomControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'hybrid', 'terrain'],
          },
          backgroundColor: '#ede8e0',
        });

        mapRef.current = map;
        layersRef.current.infoWindow = new google.maps.InfoWindow();
        setReady(true);
      } catch (err: any) {
        console.error('Google Maps load failed:', err);
        setLoadError(err?.message || 'Failed to load Google Maps');
      }
    })();

    return () => {
      cancelled = true;
      // Google Maps doesn't have a destroy() — clearing the container is enough
      const layers = layersRef.current;
      layers.routePolylines.forEach((p) => p.setMap(null));
      layers.routePolylines.clear();
      layers.legMarkers.forEach((m) => m.setMap(null));
      layers.legMarkers.clear();
      if (layers.finalMarker) layers.finalMarker.setMap(null);
      layers.finalMarker = null;
      layers.poiMarkers.forEach((m) => m.setMap(null));
      layers.poiMarkers = [];
      layers.gpxPolylines.forEach((arr) => arr.forEach((p) => p.setMap(null)));
      layers.gpxPolylines.clear();
      if (layers.fallbackPolyline) layers.fallbackPolyline.setMap(null);
      layers.fallbackPolyline = null;
      mapRef.current = null;
      // directionsServiceRef cleanup removed
    };
  }, []);

  // Populate route cache from stored geometry (persisted at planning time).
  // No external API calls — the polyline comes from the DB via getTripFull().
  useEffect(() => {
    if (!ready) return;

    let added = false;
    for (const leg of legs) {
      const key = legKey(leg);
      if (routeCacheRef.current.has(key)) continue;

      if (leg.geometry && leg.geometry.coordinates.length > 0) {
        // GeoJSON uses [lng, lat] — Google Maps needs { lat, lng }
        const path = leg.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        routeCacheRef.current.set(key, path);
        added = true;
      }
    }
    if (added) setRoutesVersion((v) => v + 1);
  }, [ready, legs]);

  // Render markers + route polylines whenever data or selection changes
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const layers = layersRef.current;

    // Wipe existing
    layers.routePolylines.forEach((p) => p.setMap(null));
    layers.routePolylines.clear();
    layers.gapPolylines.forEach((p) => p.setMap(null));
    layers.gapPolylines = [];
    layers.legMarkers.forEach((m) => m.setMap(null));
    layers.legMarkers.clear();
    if (layers.finalMarker) layers.finalMarker.setMap(null);
    layers.finalMarker = null;
    layers.poiMarkers.forEach((m) => m.setMap(null));
    layers.poiMarkers = [];
    if (layers.fallbackPolyline) layers.fallbackPolyline.setMap(null);
    layers.fallbackPolyline = null;

    const allPoints: google.maps.LatLngLiteral[] = [];

    // Per-leg road-following polylines (or straight-line fallback while routes load)
    legs.forEach((leg) => {
      const isSelected = leg.id === selectedLegId;
      const color = leg.color || '#4E7AB0';

      const cached = routeCacheRef.current.get(legKey(leg));
      if (cached?.length) {
        const poly = new google.maps.Polyline({
          path: cached,
          map,
          strokeColor: color,
          strokeOpacity: isSelected ? 1.0 : 0.85,
          strokeWeight: isSelected ? 6 : 4,
          zIndex: isSelected ? 10 : 1,
        });
        poly.addListener('click', () => onLegSelectRef.current(leg.id));
        layers.routePolylines.set(leg.id, poly);
        cached.forEach((pt) => allPoints.push(pt));
      } else if (
        leg.start_lat != null &&
        leg.start_lng != null &&
        leg.end_lat != null &&
        leg.end_lng != null
      ) {
        const poly = new google.maps.Polyline({
          path: [
            { lat: leg.start_lat, lng: leg.start_lng },
            { lat: leg.end_lat, lng: leg.end_lng },
          ],
          map,
          strokeColor: color,
          strokeOpacity: 0.5,
          strokeWeight: 2,
          icons: [
            {
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.6, scale: 3 },
              offset: '0',
              repeat: '14px',
            },
          ],
        });
        layers.routePolylines.set(leg.id, poly);
        allPoints.push(
          { lat: leg.start_lat, lng: leg.start_lng },
          { lat: leg.end_lat, lng: leg.end_lng }
        );
      }
    });

    // Gap polylines: dashed red lines between non-contiguous consecutive legs
    // so the user can see where Penny left a hole in the route.
    for (let i = 0; i < legs.length - 1; i++) {
      const curr = legs[i];
      const next = legs[i + 1];
      if (
        curr.end_lat != null && curr.end_lng != null &&
        next.start_lat != null && next.start_lng != null
      ) {
        // Only draw if gap is meaningful (>25km as-the-crow-flies)
        const dlat = curr.end_lat - next.start_lat;
        const dlng = curr.end_lng - next.start_lng;
        const approxKm = Math.sqrt(dlat * dlat + dlng * dlng) * 111;
        if (approxKm > 25) {
          const gapPoly = new google.maps.Polyline({
            path: [
              { lat: curr.end_lat, lng: curr.end_lng },
              { lat: next.start_lat, lng: next.start_lng },
            ],
            map,
            strokeColor: '#c65d4a',
            strokeOpacity: 0,
            strokeWeight: 3,
            icons: [
              {
                icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, strokeColor: '#c65d4a', scale: 3 },
                offset: '0',
                repeat: '12px',
              },
            ],
            zIndex: 0,
          });
          layers.gapPolylines.push(gapPoly);
          allPoints.push(
            { lat: curr.end_lat, lng: curr.end_lng },
            { lat: next.start_lat, lng: next.start_lng }
          );
        }
      }
    }

    // Leg start markers
    legs.forEach((leg) => {
      if (leg.start_lat == null || leg.start_lng == null) return;
      const isSelected = leg.id === selectedLegId;
      const color = leg.color || '#4E7AB0';
      const size = isSelected ? 18 : 14;

      const marker = new google.maps.Marker({
        position: { lat: leg.start_lat, lng: leg.start_lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          scale: size / 2,
        },
        zIndex: isSelected ? 20 : 5,
      });

      marker.addListener('click', () => {
        const iw = layers.infoWindow;
        if (iw) {
          iw.setContent(`
            <div style="min-width: 180px; font-family: var(--tp-font-sans);">
              <div style="font-size: 10px; color: #5c5c5c; font-weight: 600; letter-spacing: 0.05em;">${leg.label ?? ''}</div>
              <div style="font-size: 14px; font-weight: 600; margin: 4px 0; color: #333;">${leg.title}</div>
              <div style="font-size: 12px; color: #6b6b6b;">${leg.dates || ''}</div>
              <div style="font-size: 12px; color: #6b6b6b; margin-top: 2px;">
                ${leg.distance_km ? leg.distance_km + ' km' : ''} ${leg.drive_time_minutes ? '• ' + Math.round(leg.drive_time_minutes / 60) + ' hrs' : ''}
              </div>
              <div style="font-size: 11px; color: #8a8a8a; margin-top: 4px;">${leg.overnight || ''}</div>
            </div>
          `);
          iw.open({ anchor: marker, map });
        }
        onLegSelectRef.current(leg.id);
      });

      layers.legMarkers.set(leg.id, marker);
    });

    // Final destination marker
    const lastLeg = legs[legs.length - 1];
    if (lastLeg?.end_lat != null && lastLeg?.end_lng != null) {
      layers.finalMarker = new google.maps.Marker({
        position: { lat: lastLeg.end_lat, lng: lastLeg.end_lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: lastLeg.color || '#B8956A',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
          scale: 10,
        },
        zIndex: 30,
      });
      layers.finalMarker.addListener('click', () => {
        const iw = layers.infoWindow;
        if (iw) {
          iw.setContent(
            '<div style="font-size: 16px; font-weight: 700; color: #333;">Nordkapp</div><div style="font-size: 12px; color: #6b6b6b;">71.17°N — The Goal</div>'
          );
          iw.open({ anchor: layers.finalMarker!, map });
        }
      });
    }

    // POI markers
    pois.forEach((poi) => {
      const m = new google.maps.Marker({
        position: { lat: poi.lat, lng: poi.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: '#E8D57C',
          fillOpacity: 0.7,
          strokeColor: '#ffffff',
          strokeWeight: 1,
          scale: 4,
        },
        zIndex: 2,
      });
      m.addListener('click', () => {
        const iw = layers.infoWindow;
        if (iw) {
          iw.setContent(`
            <div style="min-width: 150px; font-family: var(--tp-font-sans);">
              <div style="font-size: 13px; font-weight: 600; color: #333;">${poi.name}</div>
              <div style="font-size: 11px; color: #6b6b6b;">${poi.source} ${poi.rating ? '• ★ ' + poi.rating : ''}</div>
              ${poi.url ? `<a href="${poi.url}" target="_blank" style="font-size: 11px;">View on source →</a>` : ''}
            </div>
          `);
          iw.open({ anchor: m, map });
        }
      });
      layers.poiMarkers.push(m);
    });
  }, [ready, legs, pois, selectedLegId, routesVersion]);

  // Fetch and render GPX trails for each leg
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const layers = layersRef.current;

    let cancelled = false;
    (async () => {
      // On every trailsVersion bump, wipe and re-fetch all GPX overlays.
      layers.gpxPolylines.forEach((arr) => arr.forEach((p) => p.setMap(null)));
      layers.gpxPolylines.clear();

      for (const leg of legs) {
        const baseKey = `leg:${leg.id}`;

        try {
          const res = await fetch(`/api/gpx?tripId=${tripId}&legId=${leg.id}`);
          if (!res.ok) continue;
          const trails = (await res.json()) as Array<{
            id: string;
            name: string;
            geojson: GpxFeatureCollection;
            color?: string;
            surface?: string;
          }>;
          if (cancelled) return;

          trails.forEach((trail, idx) => {
            const trailColor = trail.color || leg.color || '#E8D57C';
            const polylines: google.maps.Polyline[] = [];
            trail.geojson.features.forEach((f) => {
              const lines: [number, number, number?][][] = [];
              if (f.geometry.type === 'LineString') lines.push(f.geometry.coordinates);
              else if (f.geometry.type === 'MultiLineString')
                lines.push(...f.geometry.coordinates);

              lines.forEach((line) => {
                const path = line.map(([lng, lat]) => ({ lat, lng }));
                if (path.length < 2) return;
                const poly = new google.maps.Polyline({
                  path,
                  map,
                  strokeColor: trailColor,
                  strokeOpacity: 0.95,
                  strokeWeight: 4,
                  zIndex: 6,
                  icons: [
                    {
                      icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
                      offset: '0',
                      repeat: '10px',
                    },
                  ],
                });
                polylines.push(poly);
              });
            });
            if (polylines.length) {
              layers.gpxPolylines.set(`${baseKey}#${trail.id ?? idx}`, polylines);
            }
          });
        } catch (err) {
          console.warn(`GPX fetch failed for leg ${leg.id}:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, legs, trailsVersion, tripId]);

  // Fit bounds once when initial routes are available
  const fittedRef = useRef(false);
  useEffect(() => {
    if (!ready || !mapRef.current || fittedRef.current) return;
    const pts: google.maps.LatLngLiteral[] = [];
    legs.forEach((leg) => {
      const cached = routeCacheRef.current.get(legKey(leg));
      if (cached?.length) cached.forEach((p) => pts.push(p));
      else {
        if (leg.start_lat != null && leg.start_lng != null)
          pts.push({ lat: leg.start_lat, lng: leg.start_lng });
        if (leg.end_lat != null && leg.end_lng != null)
          pts.push({ lat: leg.end_lat, lng: leg.end_lng });
      }
    });
    if (pts.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    mapRef.current.fitBounds(bounds, 40);
    fittedRef.current = true;
  }, [ready, legs, routesVersion]);

  // Pan to selected leg without disturbing zoom
  useEffect(() => {
    if (!ready || !mapRef.current || selectedLegId == null) return;
    const leg = legs.find((l) => l.id === selectedLegId);
    if (!leg || leg.start_lat == null || leg.start_lng == null) return;
    mapRef.current.panTo({ lat: leg.start_lat, lng: leg.start_lng });
  }, [ready, selectedLegId, legs]);

  return (
    <div
      data-testid="trip-map"
      data-map-ready={ready ? 'true' : 'false'}
      data-leg-count={legs.length}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--tp-map-chrome)' }} />
      {loadError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--tp-overlay)',
            color: 'var(--tp-text)',
            padding: 24,
            textAlign: 'center',
            fontSize: 13,
            
            lineHeight: 1.6,
          }}
        >
          Map failed to load.
          <br />
          {loadError}
        </div>
      )}
      {!ready && !loadError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--tp-map-chrome)',
            color: 'var(--tp-muted)',
            fontSize: 13,
            
            pointerEvents: 'none',
          }}
        >
          Loading Google Maps…
        </div>
      )}
    </div>
  );
}
