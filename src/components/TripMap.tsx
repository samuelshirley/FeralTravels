'use client';

import { useEffect, useRef, useState } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import type { LegWithDetails, POI, Stop, StopType } from '@/types/trip';
import { clusterPixels, type PixelPoint } from '@/lib/mapClustering';
import { useUnits } from '@/components/UnitsContext';
import { formatKmDual, type UnitsPref } from '@/lib/units';

let optionsConfigured = false;

interface TripMapProps {
  legs: LegWithDetails[];
  pois: POI[];
  selectedLegId: string | null;
  onLegSelect: (legId: string) => void;
  /**
   * Fired when the user clicks a stop marker (fuel or user-added) on the map.
   * The parent opens that stop in the list view (expand owning leg + scroll).
   */
  onStopSelect?: (legId: string, stopId: string) => void;
  trailsVersion?: number;
  tripId: string;
}

/** A stop flattened out of the legs for map rendering. */
interface MapStopPoint {
  legId: string;
  stopId: string;
  lat: number;
  lng: number;
  type: StopType;
  name: string;
  distanceKm: number | null;
}

const STOP_GRID_CELL_PX = 64;
/*
 * Map marker colours. Literals rather than `--tp-*` because the Maps API and
 * react-native-maps both take colour STRINGS, not CSS — same reason
 * DARK_MAP_STYLE is literal. Keep in step with src/app/globals.css.
 *
 * Under the mono palette fuel and the route are the SAME accent: a fuel marker
 * is distinguished by its glyph and its ring, not by hue. The two that keep a
 * colour of their own are the gap warning (danger, because it is the one thing
 * on the map that means something is wrong) and base days.
 */
const FUEL_STOP_COLOR = '#9184d9';
const OTHER_STOP_COLOR = '#b2b6ca';
const CLUSTER_COLOR = '#595d6c';

/** Flatten every renderable stop (has coords, not dismissed) out of the legs. */
function collectStopPoints(legs: LegWithDetails[]): MapStopPoint[] {
  const out: MapStopPoint[] = [];
  for (const leg of legs) {
    for (const stop of leg.stops) {
      if (stop.status === 'dismissed') continue;
      if (stop.lat == null || stop.lng == null) continue;
      out.push({
        legId: leg.id,
        stopId: String(stop.id),
        lat: stop.lat,
        lng: stop.lng,
        type: stop.stop_type,
        name: stop.name,
        distanceKm: stop.distance_from_start_km,
      });
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/**
 * Nocturne basemap.
 *
 * The web map is Google's JS API, so unlike native — which is Apple Maps and
 * follows `userInterfaceStyle: 'dark'` for free — the dark ground has to be
 * declared feature by feature. Without this the map is the one full-bleed
 * light surface left in a dark app, which is exactly how it looked.
 *
 * Colours are the `--tp-*` values as literals, because the Maps API takes a
 * style array rather than CSS. POI and transit stay OFF: the app draws its own
 * markers, and Google's would compete with them.
 */
const DARK_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1f2130' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#161826' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#b2b6ca' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#595d6c' }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#3f424d' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#e9e9ed' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#292b31' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#75798c' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3f424d' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#595d6c' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#12131f' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#5d5294' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#1b1d2a' }] },
];

function legKey(leg: LegWithDetails): string {
  return `${leg.id}:${leg.start_lat},${leg.start_lng}->${leg.end_lat},${leg.end_lng}`;
}

/**
 * "62 km (38 mi) from start", or just "62 km" for a metric user — the same
 * primary-plus-secondary shape the `Distance` component renders in React,
 * flattened to a string because an info window takes HTML, not JSX.
 */
function stopDistanceLabel(km: number, units: UnitsPref): string {
  const { primary, secondary } = formatKmDual(km, units);
  return secondary ? `${primary} ${secondary}` : primary;
}

export default function TripMap({ legs, pois, selectedLegId, onLegSelect, onStopSelect, trailsVersion = 0, tripId }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  // directionsServiceRef removed — routes come from stored DB geometry now
  const layersRef = useRef<{
    routePolylines: Map<string, google.maps.Polyline>;
    gapPolylines: google.maps.Polyline[];
    legMarkers: Map<string, google.maps.Marker>;
    finalMarker: google.maps.Marker | null;
    poiMarkers: google.maps.Marker[];
    stopMarkers: google.maps.Marker[];
    clusterMarkers: google.maps.Marker[];
    stopsIdleListener: google.maps.MapsEventListener | null;
    gpxPolylines: Map<string, google.maps.Polyline[]>;
    fallbackPolyline: google.maps.Polyline | null;
    infoWindow: google.maps.InfoWindow | null;
    stopInfoWindow: google.maps.InfoWindow | null;
  }>({
    routePolylines: new Map(),
    gapPolylines: [],
    legMarkers: new Map(),
    finalMarker: null,
    poiMarkers: [],
    stopMarkers: [],
    clusterMarkers: [],
    stopsIdleListener: null,
    gpxPolylines: new Map(),
    fallbackPolyline: null,
    infoWindow: null,
    stopInfoWindow: null,
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

  const onStopSelectRef = useRef(onStopSelect);
  useEffect(() => {
    onStopSelectRef.current = onStopSelect;
  }, [onStopSelect]);

  /**
   * The units preference, in a ref, for the same reason the two callbacks above
   * are: the marker info window is a raw HTML STRING built inside the marker
   * effect, so it cannot read context at render time, and adding `units` to
   * that effect's deps would tear down and rebuild every marker on the map the
   * moment somebody flips the toggle. A ref keeps the next tooltip correct
   * without touching the markers already drawn.
   *
   * Before this the string was a hardcoded `${km} km` — the map tooltip and
   * StopCard were the only two distances in the app that ignored the
   * preference outright.
   */
  const { units } = useUnits();
  const unitsRef = useRef(units);
  useEffect(() => {
    unitsRef.current = units;
  }, [units]);

  // Hover tooltips only make sense on devices with a real pointer; touch falls
  // back to tap-to-open. Computed once — the device class doesn't change.
  const canHoverRef = useRef(false);
  useEffect(() => {
    canHoverRef.current =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover)').matches;
  }, []);

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
          styles: DARK_MAP_STYLE,
          disableDefaultUI: false,
          zoomControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'hybrid', 'terrain'],
          },
          backgroundColor: '#1f2130',
        });

        mapRef.current = map;
        layersRef.current.infoWindow = new google.maps.InfoWindow();
        layersRef.current.stopInfoWindow = new google.maps.InfoWindow();
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
      layers.stopMarkers.forEach((m) => m.setMap(null));
      layers.stopMarkers = [];
      layers.clusterMarkers.forEach((m) => m.setMap(null));
      layers.clusterMarkers = [];
      if (layers.stopsIdleListener) {
        layers.stopsIdleListener.remove();
        layers.stopsIdleListener = null;
      }
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
      const color = leg.color || '#9184d9';

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
            strokeColor: '#E8705C',
            strokeOpacity: 0,
            strokeWeight: 3,
            icons: [
              {
                icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, strokeColor: '#E8705C', scale: 3 },
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
      const color = leg.color || '#9184d9';
      const size = isSelected ? 18 : 14;

      const marker = new google.maps.Marker({
        position: { lat: leg.start_lat, lng: leg.start_lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: '#161826',
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
          fillColor: lastLeg.color || '#d2cefd',
          fillOpacity: 1,
          strokeColor: '#161826',
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
          fillColor: '#9690c9',
          fillOpacity: 0.7,
          strokeColor: '#161826',
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

  // ── Stop markers (fuel + user-added), clustered ────────────────────────────
  // Stops only exist in `legs[].stops` once the owning day has been opened in
  // the list (lazy fuel sourcing — option B). We render whatever is loaded; the
  // map fills in as the user browses days. Clustering is screen-space (see
  // lib/mapClustering) so dense fuel runs collapse into a count bubble when
  // zoomed out and resolve into individual, clickable markers when zoomed in.
  // Re-runs on every map 'idle' so the clustering tracks zoom/pan.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const layers = layersRef.current;

    const points = collectStopPoints(legs);

    const wipe = () => {
      layers.stopMarkers.forEach((m) => m.setMap(null));
      layers.stopMarkers = [];
      layers.clusterMarkers.forEach((m) => m.setMap(null));
      layers.clusterMarkers = [];
    };

    const projectToPixel = (lat: number, lng: number): { x: number; y: number } | null => {
      const proj = map.getProjection();
      if (!proj) return null;
      const world = proj.fromLatLngToPoint(new google.maps.LatLng(lat, lng));
      if (!world) return null;
      const scale = 2 ** (map.getZoom() ?? 0);
      return { x: world.x * scale, y: world.y * scale };
    };

    const renderStopMarker = (p: MapStopPoint) => {
      const isFuel = p.type === 'fuel';
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        // Square glyph so stops read differently from the round leg/destination
        // dots. Gold = fuel, slate = user-added.
        icon: {
          path: 'M -1,-1 L 1,-1 L 1,1 L -1,1 Z',
          fillColor: isFuel ? FUEL_STOP_COLOR : OTHER_STOP_COLOR,
          fillOpacity: 1,
          strokeColor: '#161826',
          strokeWeight: 1.5,
          scale: 5,
          anchor: new google.maps.Point(0, 0),
        },
        title: p.name,
        zIndex: 8,
      });
      marker.addListener('click', () => {
        onStopSelectRef.current?.(p.legId, p.stopId);
      });
      if (canHoverRef.current) {
        const html = `
          <div style="min-width: 160px; font-family: var(--tp-font-sans);">
            <div style="font-size: 10px; color: ${isFuel ? FUEL_STOP_COLOR : '#b2b6ca'}; font-weight: 700; letter-spacing: 0.06em;">${isFuel ? 'FUEL' : 'STOP'}</div>
            <div style="font-size: 13px; font-weight: 600; margin: 2px 0; color: #333;">${escapeHtml(p.name)}</div>
            ${p.distanceKm != null ? `<div style="font-size: 11px; color: #6b6b6b;">${stopDistanceLabel(p.distanceKm, unitsRef.current)} from start</div>` : ''}
            <div style="font-size: 10px; color: #aaa; margin-top: 4px;">Click to open in list</div>
          </div>`;
        marker.addListener('mouseover', () => {
          const iw = layers.stopInfoWindow;
          if (iw) {
            iw.setContent(html);
            iw.open({ anchor: marker, map });
          }
        });
        marker.addListener('mouseout', () => {
          layers.stopInfoWindow?.close();
        });
      }
      layers.stopMarkers.push(marker);
    };

    const renderClusterMarker = (members: MapStopPoint[]) => {
      const count = members.length;
      const lat = members.reduce((s, m) => s + m.lat, 0) / count;
      const lng = members.reduce((s, m) => s + m.lng, 0) / count;
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: CLUSTER_COLOR,
          fillOpacity: 0.92,
          strokeColor: '#161826',
          strokeWeight: 2,
          scale: 12 + Math.min(count, 9),
        },
        label: {
          text: String(count),
          color: '#e9e9ed',
          fontSize: '11px',
          fontWeight: '700',
        },
        zIndex: 9,
      });
      marker.addListener('click', () => {
        const bounds = new google.maps.LatLngBounds();
        members.forEach((m) => bounds.extend({ lat: m.lat, lng: m.lng }));
        // Co-located members give an empty-area bounds → fitBounds zooms to max
        // and the cluster never breaks apart. Nudge the zoom instead.
        if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
          map.panTo({ lat, lng });
          map.setZoom(Math.min((map.getZoom() ?? 0) + 2, 18));
        } else {
          map.fitBounds(bounds, 80);
        }
      });
      layers.clusterMarkers.push(marker);
    };

    const render = () => {
      wipe();
      if (points.length === 0) return;

      const byId = new Map(points.map((p) => [p.stopId, p]));
      const pixels: PixelPoint[] = [];
      let projectionReady = true;
      for (const p of points) {
        const px = projectToPixel(p.lat, p.lng);
        if (!px) {
          projectionReady = false;
          break;
        }
        pixels.push({ id: p.stopId, x: px.x, y: px.y });
      }

      // Projection not ready yet (tiles still loading) → render everything as
      // individual markers; the next 'idle' tick will cluster properly.
      const groups = projectionReady
        ? clusterPixels(pixels, STOP_GRID_CELL_PX)
        : points.map((p) => ({ ids: [p.stopId] }));

      for (const group of groups) {
        if (group.ids.length === 1) {
          const p = byId.get(group.ids[0]);
          if (p) renderStopMarker(p);
        } else {
          const members = group.ids
            .map((id) => byId.get(id))
            .filter((m): m is MapStopPoint => m != null);
          if (members.length === 1) renderStopMarker(members[0]);
          else if (members.length > 1) renderClusterMarker(members);
        }
      }
    };

    render();

    // Re-cluster after the map settles from any zoom/pan.
    if (layers.stopsIdleListener) layers.stopsIdleListener.remove();
    layers.stopsIdleListener = map.addListener('idle', render);

    return () => {
      if (layers.stopsIdleListener) {
        layers.stopsIdleListener.remove();
        layers.stopsIdleListener = null;
      }
      wipe();
    };
  }, [ready, legs]);

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
            const trailColor = trail.color || leg.color || '#9690c9';
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

  // Fuel stops are sourced lazily when a day is opened in the list, so a trip
  // the user hasn't browsed has no stops to plot. Show a quiet hint so the
  // empty map reads as intentional rather than broken (see option B writeup).
  const hasLoadedStops = legs.some((l) =>
    l.stops.some((s) => s.status !== 'dismissed' && s.lat != null && s.lng != null),
  );
  const showNoStopsHint = ready && !loadError && legs.length > 0 && !hasLoadedStops;

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
      {showNoStopsHint && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--tp-surface)',
            color: 'var(--tp-muted)',
            border: '1px solid var(--tp-border)',
            borderRadius: 999,
            padding: '6px 14px',
            fontSize: 12,
            boxShadow: 'var(--tp-shadow-sm)',
            pointerEvents: 'none',
            maxWidth: '85%',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Open a day to load its fuel stops
        </div>
      )}
    </div>
  );
}
