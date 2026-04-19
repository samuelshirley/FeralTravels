'use client';

import { useEffect, useRef, useState } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import type { LegWithDetails, POI } from '@/types/trip';

let optionsConfigured = false;

interface TripMapProps {
  legs: LegWithDetails[];
  pois: POI[];
  selectedLegId: number | null;
  onLegSelect: (legId: number) => void;
  trailsVersion?: number;
  tripId: number;
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

const DARK_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0d0d1a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9ca3af' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#3a3a5c' }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#2a2a44' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#bcbdc7' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a44' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7c7c99' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3d3d66' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#4a4a7a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1828' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3d6a8c' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#1f2438' }] },
];

function legKey(leg: LegWithDetails): string {
  return `${leg.id}:${leg.start_lat},${leg.start_lng}->${leg.end_lat},${leg.end_lng}`;
}

export default function TripMap({ legs, pois, selectedLegId, onLegSelect, trailsVersion = 0, tripId }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(null);
  const layersRef = useRef<{
    routePolylines: Map<number, google.maps.Polyline>;
    legMarkers: Map<number, google.maps.Marker>;
    finalMarker: google.maps.Marker | null;
    poiMarkers: google.maps.Marker[];
    gpxPolylines: Map<string, google.maps.Polyline[]>;
    fallbackPolyline: google.maps.Polyline | null;
    infoWindow: google.maps.InfoWindow | null;
  }>({
    routePolylines: new Map(),
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
        const [{ Map: GMap }, { DirectionsService }] = await Promise.all([
          importLibrary('maps'),
          importLibrary('routes'),
        ]);
        if (cancelled || !el.isConnected || mapRef.current) return;

        const map = new GMap(el, {
          center: { lat: 52, lng: 10 },
          zoom: 5,
          styles: DARK_STYLE,
          disableDefaultUI: false,
          zoomControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'hybrid', 'terrain'],
          },
          backgroundColor: '#1a1a2e',
        });

        mapRef.current = map;
        directionsServiceRef.current = new DirectionsService();
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
      directionsServiceRef.current = null;
    };
  }, []);

  // Fetch road-following routes for each leg via Directions API (cached)
  useEffect(() => {
    if (!ready) return;
    const service = directionsServiceRef.current;
    if (!service) return;

    let cancelled = false;
    (async () => {
      let added = false;
      for (const leg of legs) {
        if (
          leg.start_lat == null ||
          leg.start_lng == null ||
          leg.end_lat == null ||
          leg.end_lng == null
        )
          continue;

        const key = legKey(leg);
        if (routeCacheRef.current.has(key)) continue;

        try {
          const result = await service.route({
            origin: { lat: leg.start_lat, lng: leg.start_lng },
            destination: { lat: leg.end_lat, lng: leg.end_lng },
            travelMode: google.maps.TravelMode.DRIVING,
          });
          if (cancelled) return;
          const path = result.routes[0]?.overview_path?.map((p) => ({
            lat: p.lat(),
            lng: p.lng(),
          }));
          if (path?.length) {
            routeCacheRef.current.set(key, path);
            added = true;
          }
        } catch (err) {
          console.warn(`Directions failed for leg ${leg.id}:`, err);
        }
      }
      if (added && !cancelled) setRoutesVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, legs]);

  // Render markers + route polylines whenever data or selection changes
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const layers = layersRef.current;

    // Wipe existing
    layers.routePolylines.forEach((p) => p.setMap(null));
    layers.routePolylines.clear();
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
      const color = leg.color || '#7CB5E8';

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

    // Leg start markers
    legs.forEach((leg) => {
      if (leg.start_lat == null || leg.start_lng == null) return;
      const isSelected = leg.id === selectedLegId;
      const color = leg.color || '#7CB5E8';
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
            <div style="min-width: 180px; font-family: 'Inter', sans-serif;">
              <div style="font-size: 10px; color: #666; font-weight: 600; letter-spacing: 0.05em;">${leg.label ?? ''}</div>
              <div style="font-size: 14px; font-weight: 600; margin: 4px 0;">${leg.title}</div>
              <div style="font-size: 12px; color: #888;">${leg.dates || ''}</div>
              <div style="font-size: 12px; color: #888; margin-top: 2px;">
                ${leg.distance_km ? leg.distance_km + ' km' : ''} ${leg.drive_time_minutes ? '• ' + Math.round(leg.drive_time_minutes / 60) + ' hrs' : ''}
              </div>
              <div style="font-size: 11px; color: #aaa; margin-top: 4px;">${leg.overnight || ''}</div>
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
          fillColor: lastLeg.color || '#E8C17C',
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
            '<div style="font-size: 16px; font-weight: 700;">Nordkapp</div><div style="font-size: 12px; color: #888;">71.17°N — The Goal</div>'
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
            <div style="min-width: 150px; font-family: 'Inter', sans-serif;">
              <div style="font-size: 13px; font-weight: 600;">${poi.name}</div>
              <div style="font-size: 11px; color: #888;">${poi.source} ${poi.rating ? '• ★ ' + poi.rating : ''}</div>
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
            id: number;
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
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#1a1a2e' }} />
      {loadError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(13,13,13,0.85)',
            color: 'rgba(255,255,255,0.7)',
            padding: 24,
            textAlign: 'center',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace",
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
            background: '#1a1a2e',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace",
            pointerEvents: 'none',
          }}
        >
          Loading Google Maps…
        </div>
      )}
    </div>
  );
}
