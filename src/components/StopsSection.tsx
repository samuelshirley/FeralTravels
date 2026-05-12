'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { tripApi, ApiError } from '@/lib/api';
import { buildDogParkSearchUrl, buildParkSearchUrl } from '@/lib/maps';
import { parseCoords, needsServerResolution } from '@/lib/coords';
import { classifyFuelPlanError } from '@/lib/fuelPlanErrorSemantics';
import Spinner from './Spinner';
import Distance from './Distance';

interface StopsSectionProps {
  tripId: number;
  legId: number;
  legEndName: string | null;
  legEndCoords: { lat: number | null; lng: number | null };
  legStartCoords?: { lat: number | null; lng: number | null };
  initialStops: Stop[];
  /**
   * Per-leg auto fuel lifecycle from the server (`computing` while trip-wide
   * replan runs).
   */
  fuelStatus?: FuelStatus;
  /** Last server-side fuel planner error when fuelStatus is failed. */
  fuelPlanError?: string | null;
  onChanged?: () => void;
  readonly?: boolean;
}

/** Matches TRAILS / GPX subsection shell in [`LegCard.tsx`](/src/components/LegCard.tsx). */
const legSubsectionCardStyle: CSSProperties = {
  marginTop: 12,
  padding: '10px 14px',
  background: 'var(--tp-surface-muted)',
  borderRadius: 6,
  border: '1px solid var(--tp-border)',
};

const legSubsectionTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: 'var(--tp-subtle)',
  marginBottom: 6,
};

const TYPE_ORDER: StopType[] = ['fuel', 'water', 'food', 'overnight', 'rest', 'other'];

const TYPE_META: Record<StopType, { label: string; color: string; icon: string }> = {
  fuel: { label: 'Fuel', color: 'var(--tp-gold)', icon: '⛽' },
  water: { label: 'Water', color: 'var(--tp-primary)', icon: '💧' },
  food: { label: 'Food', color: 'var(--tp-accent-warm)', icon: '🍴' },
  overnight: { label: 'Overnight', color: '#8B7AB8', icon: '🌙' },
  rest: { label: 'Rest', color: 'var(--tp-success)', icon: '☕' },
  other: { label: 'Other', color: 'var(--tp-muted)', icon: '📍' },
};

type NearbyRow = {
  name: string;
  lat: number;
  lng: number;
  placeId: string | null;
  primaryType: string | null;
  googleMapsUri: string | null;
  distanceKm: number;
  within5Km: boolean;
};

/**
 * Quick haversine. We don't import from `@/lib/polyline` because that
 * module also pulls in the polyline decoder which we don't need on the
 * client for the parks list.
 */
function haversineKmLocal(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pick the top dog park + top park to surface as the leg's curated
 * overnight suggestion. We prefer a pair within `maxKm` of each other so
 * the same campsite serves both walks. If no pair qualifies, fall back to
 * the closest entry in each list independently.
 */
function pickTopPair(
  dogs: NearbyRow[],
  parks: NearbyRow[],
  maxKm: number
): { dog: NearbyRow | null; park: NearbyRow | null } {
  if (dogs.length === 0 && parks.length === 0) return { dog: null, park: null };
  if (dogs.length === 0) return { dog: null, park: parks[0] ?? null };
  if (parks.length === 0) return { dog: dogs[0] ?? null, park: null };
  for (const d of dogs) {
    for (const p of parks) {
      if (haversineKmLocal({ lat: d.lat, lng: d.lng }, { lat: p.lat, lng: p.lng }) <= maxKm) {
        return { dog: d, park: p };
      }
    }
  }
  return { dog: dogs[0], park: parks[0] };
}

export default function StopsSection({
  tripId,
  legId,
  legEndName,
  legEndCoords,
  legStartCoords: _legStartCoords,
  initialStops,
  fuelStatus = 'none',
  fuelPlanError = null,
  onChanged,
  readonly = false,
}: StopsSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  void _legStartCoords;
  void legEndName;

  const [stops, setStops] = useState<Stop[]>(initialStops);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const addingType: StopType = 'overnight';

  const [nearbyBusy, setNearbyBusy] = useState(
    () =>
      Boolean(
        legEndCoords.lat != null &&
          legEndCoords.lng != null &&
          typeof legId === 'number' &&
          !readonly
      )
  );
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyDog, setNearbyDog] = useState<NearbyRow[]>([]);
  const [nearbyParksGreen, setNearbyParksGreen] = useState<NearbyRow[]>([]);
  const [addingParkKey, setAddingParkKey] = useState<string | null>(null);

  const parksCacheRef = useRef(
    new Map<string, { dogParks: NearbyRow[]; parks: NearbyRow[]; error?: string }>()
  );

  const fuelPlanning = fuelStatus === 'computing' || fuelStatus === 'pending';
  const pathname = usePathname();
  const fuelErrorCategory = classifyFuelPlanError(fuelPlanError);
  const setupReturnTarget = pathname && pathname.startsWith('/') ? pathname : `/trips/${tripId}`;
  const vehicleSetupHref = `/vehicle-setup?returnTo=${encodeURIComponent(setupReturnTarget)}`;

  const hasEndCoords = legEndCoords.lat != null && legEndCoords.lng != null;
  const anchorLat = legEndCoords.lat as number | undefined;
  const anchorLng = legEndCoords.lng as number | undefined;

  const parksMountKey =
    anchorLat !== undefined && anchorLng !== undefined
      ? `${legId}:${anchorLat.toFixed(4)}:${anchorLng.toFixed(4)}`
      : '';

  async function reload() {
    try {
      const data = await api.listStopsForLeg(legId);
      if (Array.isArray(data)) setStops(data as Stop[]);
      onChanged?.();
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    setStops(initialStops);
  }, [initialStops]);

  useEffect(() => {
    if (!hasEndCoords || readonly || !parksMountKey || anchorLat == null || anchorLng == null)
      return;
    const cached = parksCacheRef.current.get(parksMountKey);
    if (cached) {
      setNearbyDog(cached.dogParks);
      setNearbyParksGreen(cached.parks);
      setNearbyError(cached.error ?? null);
      setNearbyBusy(false);
      return;
    }

    const ac = new AbortController();
    setNearbyBusy(true);
    setNearbyError(null);

    api
      .nearbyParks(legId, { lat: anchorLat, lng: anchorLng }, { signal: ac.signal, skipGlobalErrorReport: true })
      .then((data) => {
        if (!data || typeof data !== 'object') return;
        const dogList = Array.isArray((data as any).dogParks) ? (data as any).dogParks : [];
        const parkList = Array.isArray((data as any).parks) ? (data as any).parks : [];
        const msg = typeof (data as any).error === 'string' ? (data as any).error : undefined;
        parksCacheRef.current.set(parksMountKey, {
          dogParks: dogList,
          parks: parkList,
          error: msg,
        });
        setNearbyDog(dogList);
        setNearbyParksGreen(parkList);
        setNearbyError(msg ?? null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const msg =
          err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not load nearby parks.';
        setNearbyDog([]);
        setNearbyParksGreen([]);
        setNearbyError(msg);
      })
      .finally(() => {
        if (!ac.signal.aborted) setNearbyBusy(false);
      });

    return () => ac.abort();
  }, [anchorLat, anchorLng, api, hasEndCoords, legId, parksMountKey, readonly]);

  async function handleAddFromPaste() {
    const raw = pasteValue.trim();
    if (!raw) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      const parsed = parseCoords(raw);
      let coords = parsed;
      if (!coords && needsServerResolution(raw)) {
        coords = (await api.parseCoords(raw)) as typeof parsed;
      }
      if (!coords) {
        setPasteError(
          'Could not read coordinates from that — try decimal "lat, lng" or a Google Maps URL. (For iOverlander / Park4Night spots, copy the coords from their app and paste them here.)'
        );
        return;
      }
      await api.addStop(legId, {
        stop_type: addingType,
        name: coords.name || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
        lat: coords.lat,
        lng: coords.lng,
        status: 'selected',
        source: coords.source ?? 'user',
        source_url: coords.source_url ?? null,
      });
      setPasteValue('');
      await reload();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add stop';
      setPasteError(msg);
    } finally {
      setPasteBusy(false);
    }
  }

  async function handleAddNearbyPlace(row: NearbyRow) {
    const key =
      row.placeId ?? `${row.lat.toFixed(5)}:${row.lng.toFixed(5)}`;
    if (addingParkKey) return;
    setAddingParkKey(key);
    try {
      await api.addStop(legId, {
        stop_type: 'rest',
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        status: 'selected',
        source: 'google_places',
        source_url: row.googleMapsUri ?? null,
      });
      await reload();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add stop';
      setNearbyError(msg);
    } finally {
      setAddingParkKey(null);
    }
  }

  /**
   * Promote a nearby park / dog park into the leg's overnight slot. We
   * dismiss any existing google_places-sourced overnight options first so
   * the leg only has one active overnight at a time, then insert the new
   * row as stop_type='overnight', status='selected'. User-authored
   * overnights (source != 'google_places') are NOT touched — those came
   * from the user directly and they can manage them by hand.
   */
  async function handleSetOvernight(row: NearbyRow) {
    const key =
      row.placeId ?? `${row.lat.toFixed(5)}:${row.lng.toFixed(5)}`;
    if (addingParkKey) return;
    setAddingParkKey(key);
    try {
      const existingOvernights = stops.filter(
        (s) =>
          s.stop_type === 'overnight' &&
          s.status !== 'dismissed' &&
          s.source === 'google_places'
      );
      for (const existing of existingOvernights) {
        await api
          .updateStop(existing.id, { status: 'dismissed' }, { skipGlobalErrorReport: true })
          .catch(() => {
            /* stale id from auto-replan — fine, we'll reload below */
          });
      }
      await api.addStop(legId, {
        stop_type: 'overnight',
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        status: 'selected',
        source: 'google_places',
        source_url: row.googleMapsUri ?? null,
      });
      await reload();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add stop';
      setNearbyError(msg);
    } finally {
      setAddingParkKey(null);
    }
  }

  /**
   * Stop IDs can disappear out from under the UI when an auto fuel replan
   * runs and rewrites the auto-suggested rows. The user sees the old row in
   * the list, clicks it, and the server returns 404 because that ID is gone.
   * We treat 404 as "stale optimistic state" — silently reload the leg's
   * stops so the user sees the fresh rows. Other errors fall through to the
   * global notifier.
   */
  /**
   * Stop IDs can disappear out from under the UI when an auto fuel replan
   * runs and rewrites the auto-suggested rows. The user sees the old row in
   * the list, clicks it, and the server returns 404 because that ID is gone.
   * We pass `skipGlobalErrorReport` so the global toast doesn't fire on a
   * stale-id 404; we silently reload the leg's stops instead. Non-404 errors
   * we re-throw so the global notifier can still surface real failures.
   */
  async function handleSelect(id: number) {
    setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'selected' } : s)));
    try {
      await api.selectStop(id, { skipGlobalErrorReport: true });
      await reload();
    } catch (err) {
      await reload();
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  async function handleDismiss(id: number) {
    setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s)));
    try {
      await api.updateStop(id, { status: 'dismissed' }, { skipGlobalErrorReport: true });
      await reload();
    } catch (err) {
      await reload();
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this stop?')) return;
    try {
      await api.deleteStop(id, { skipGlobalErrorReport: true });
      await reload();
    } catch (err) {
      await reload();
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  /**
   * Swap a fuel/rest stop's primary fields with one of its persisted
   * alternates so the user can flip between Google Places candidates
   * without us re-querying Google. Server-side dispatch is in
   * /api/stops/:id/swap-primary; same 404-as-stale-id treatment as the
   * other mutation handlers above.
   */
  async function handleSwapAlternate(id: number, altIndex: number) {
    try {
      await api.swapStopPrimary(id, altIndex, { skipGlobalErrorReport: true });
      await reload();
    } catch (err) {
      await reload();
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  const groups: Array<[StopType, Stop[]]> = TYPE_ORDER.map((t) => [
    t,
    stops.filter((s) => s.stop_type === t && s.status !== 'dismissed'),
  ]).filter(([, arr]) => arr.length > 0) as Array<[StopType, Stop[]]>;
  const dismissed = stops.filter((s) => s.status === 'dismissed');

  return (
    <>
      {/* STOPS */}
      <div style={legSubsectionCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={legSubsectionTitleStyle}>STOPS</div>

        {!readonly && fuelPlanning && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Spinner size={10} thickness={2} color="var(--tp-gold)" />
            <span style={{ fontSize: 11, color: 'var(--tp-muted)' }}>Planning fuel stops…</span>
          </div>
        )}

        {!readonly && fuelStatus === 'failed' && fuelErrorCategory === 'user_vehicle_profile' && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              background: 'rgba(78,122,176,0.08)',
              border: '1px solid rgba(78,122,176,0.28)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--tp-text)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--tp-primary)' }}>Finish your vehicle profile</strong> so we can plan fuel
            stops along this leg. This is a saved-profile issue, not a broken map.
            {fuelPlanError ? (
              <>
                {' '}
                <span style={{ color: 'var(--tp-muted)' }}>{fuelPlanError}</span>
              </>
            ) : null}
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Link
                href={vehicleSetupHref}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: 4,
                  background: 'var(--tp-primary)',
                  color: 'var(--tp-on-primary)',
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
              >
                Open vehicle setup
              </Link>
              <Link
                href="/settings"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: '1px solid var(--tp-border)',
                  color: 'var(--tp-primary)',
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
              >
                Settings → Vehicle profile
              </Link>
            </div>
          </div>
        )}

        {!readonly &&
          fuelStatus === 'failed' &&
          fuelErrorCategory !== 'user_vehicle_profile' && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              background: 'rgba(198,93,74,0.08)',
              border: '1px solid rgba(198,93,74,0.3)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--tp-danger)',
              lineHeight: 1.5,
            }}
          >
            <strong>
              {fuelErrorCategory === 'platform_config'
                ? 'Fuel planning paused (Places / Maps setup).'
                : 'Fuel planning failed.'}{' '}
            </strong>
            We&apos;ll retry automatically the next time you edit a stop or change the route.
            {fuelPlanError ? (
              <>
                {' '}
                <span style={{ color: 'var(--tp-muted)' }}>{fuelPlanError}</span>
              </>
            ) : fuelErrorCategory === 'unknown' ? (
              <>
                {' '}
                (If this keeps happening, enable &quot;Places API (New)&quot; in Google Cloud and set
                GOOGLE_MAPS_SERVER_API_KEY for server-side Places calls.)
              </>
            ) : (
              <>
                {' '}
                Ask your host to verify Google Places / Directions credentials and quotas.
              </>
            )}
          </div>
        )}

        {groups.map(([type, arr]) => (
          <StopGroup
            key={type}
            type={type}
            stops={arr}
            onSelect={handleSelect}
            onDismiss={handleDismiss}
            onDelete={handleDelete}
            onSwapAlternate={handleSwapAlternate}
            readonly={readonly}
          />
        ))}

        {groups.length === 0 && !fuelPlanning && fuelStatus !== 'failed' && (
          <div style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
            {readonly ? 'No stops.' : 'No stops yet — fuel stops appear here automatically.'}
          </div>
        )}

        {dismissed.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 10,
                color: 'var(--tp-muted)',
                letterSpacing: '0.08em',
              }}
            >
              {dismissed.length} DISMISSED
            </summary>
            <div style={{ marginTop: 6 }}>
              {dismissed.map((s) => (
                <StopRow
                  key={s.id}
                  stop={s}
                  onSelect={handleSelect}
                  onDismiss={handleDismiss}
                  onDelete={handleDelete}
                  readonly={readonly}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      {/* PARKS NEAR STOP — leg end anchor (overnight-area discovery). */}
      {hasEndCoords && !readonly && anchorLat != null && anchorLng != null && (
        <div style={legSubsectionCardStyle} onClick={(e) => e.stopPropagation()}>
          <div style={legSubsectionTitleStyle}>PARKS NEAR STOP</div>

          <p style={{ fontSize: 11, color: 'var(--tp-muted)', margin: '0 0 8px 0', lineHeight: 1.45 }}>
            Google Places ideas near the destination for scouting stops or camping — optional, not prescribed. Planned
            mid-leg stretch stops (Places dog parks/parks along the route) show as Rest rows after fuel planning when your
            vehicle has max drive hours/day set.
          </p>

          {nearbyBusy ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--tp-muted)' }}>
              <Spinner size={10} thickness={2} color="var(--tp-primary)" />
              Loading nearby places…
            </div>
          ) : nearbyError &&
            nearbyDog.length === 0 &&
            nearbyParksGreen.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--tp-danger)', lineHeight: 1.45 }}>{nearbyError}</div>
          ) : (
            (() => {
              // Curate to a single top dog park + a single top park that are
              // ideally within ~5 km of each other (so the same camp serves
              // both walks). Anything past that goes behind a "Show more"
              // expander — the user told us the long flat list was too noisy.
              const topPair = pickTopPair(nearbyDog, nearbyParksGreen, 5);
              const restDog = nearbyDog.filter((r) => r !== topPair.dog);
              const restParks = nearbyParksGreen.filter((r) => r !== topPair.park);
              const hasMore = restDog.length > 0 || restParks.length > 0;
              return (
                <>
                  <ParkSuggestionGroup
                    label="DOG PARKS"
                    rows={topPair.dog ? [topPair.dog] : []}
                    readonly={readonly}
                    accentColor="var(--tp-success)"
                    accentBorder="rgba(74,139,122,0.35)"
                    onAdd={handleAddNearbyPlace}
                    onSetOvernight={handleSetOvernight}
                    addingKey={addingParkKey}
                    mapsHrefForRow={(row) =>
                      row.googleMapsUri ?? buildDogParkSearchUrl(row.lat, row.lng)
                    }
                  />
                  <ParkSuggestionGroup
                    label="PARKS"
                    rows={topPair.park ? [topPair.park] : []}
                    readonly={readonly}
                    accentColor="var(--tp-accent-violet)"
                    accentBorder="var(--tp-accent-violet-muted)"
                    onAdd={handleAddNearbyPlace}
                    onSetOvernight={handleSetOvernight}
                    addingKey={addingParkKey}
                    mapsHrefForRow={(row) =>
                      row.googleMapsUri ?? buildParkSearchUrl(row.lat, row.lng)
                    }
                  />
                  {hasMore && (
                    <details style={{ marginTop: 4 }}>
                      <summary
                        style={{
                          cursor: 'pointer',
                          fontSize: 11,
                          color: 'var(--tp-muted)',
                          letterSpacing: '0.04em',
                          padding: '4px 0',
                        }}
                      >
                        Show more nearby places
                      </summary>
                      <div style={{ marginTop: 8 }}>
                        {restDog.length > 0 && (
                          <ParkSuggestionGroup
                            label="MORE DOG PARKS"
                            rows={restDog}
                            readonly={readonly}
                            accentColor="var(--tp-success)"
                            accentBorder="rgba(74,139,122,0.35)"
                            onAdd={handleAddNearbyPlace}
                            addingKey={addingParkKey}
                            mapsHrefForRow={(row) =>
                              row.googleMapsUri ?? buildDogParkSearchUrl(row.lat, row.lng)
                            }
                          />
                        )}
                        {restParks.length > 0 && (
                          <ParkSuggestionGroup
                            label="MORE PARKS"
                            rows={restParks}
                            readonly={readonly}
                            accentColor="var(--tp-accent-violet)"
                            accentBorder="var(--tp-accent-violet-muted)"
                            onAdd={handleAddNearbyPlace}
                            addingKey={addingParkKey}
                            mapsHrefForRow={(row) =>
                              row.googleMapsUri ?? buildParkSearchUrl(row.lat, row.lng)
                            }
                          />
                        )}
                      </div>
                    </details>
                  )}
                  {(nearbyDog.length > 0 || nearbyParksGreen.length > 0) && nearbyError && (
                    <div style={{ fontSize: 10, color: 'var(--tp-muted)', marginTop: 8 }}>
                      {nearbyError}
                    </div>
                  )}
                </>
              );
            })()
          )}

          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 10,
              fontSize: 11,
              color: 'var(--tp-primary)',
            }}
          >
            <a
              href={buildDogParkSearchUrl(anchorLat, anchorLng)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--tp-primary)', textDecoration: 'underline' }}
            >
              Browse all dog parks ↗
            </a>
            <a
              href={buildParkSearchUrl(anchorLat, anchorLng)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--tp-primary)', textDecoration: 'underline' }}
            >
              Browse all parks ↗
            </a>
          </div>
        </div>
      )}

      {/* Paste GPS */}
      {!readonly && (
        <div style={legSubsectionCardStyle} onClick={(e) => e.stopPropagation()}>
          <div style={legSubsectionTitleStyle}>PASTE GPS</div>
          <p style={{ fontSize: 11, color: 'var(--tp-muted)', margin: '0 0 8px 0', lineHeight: 1.45 }}>
            Add a waypoint from decimal coordinates or a Google Maps link (still stored as overnight).
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddFromPaste();
              }}
              placeholder="Paste GPS (48.8566, 2.3522) or a Google Maps URL"
              disabled={pasteBusy}
              style={{
                flex: '1 1 240px',
                minWidth: 180,
                padding: '6px 10px',
                background: 'var(--tp-surface-muted)',
                border: '1px solid var(--tp-border)',
                borderRadius: 4,
                color: 'var(--tp-text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <button
              onClick={handleAddFromPaste}
              disabled={pasteBusy || !pasteValue.trim()}
              style={{
                fontSize: 11,
                background: pasteBusy ? 'var(--tp-surface-muted)' : 'var(--tp-primary)',
                border: 'none',
                color: pasteBusy ? 'var(--tp-muted)' : 'var(--tp-on-primary)',
                padding: '6px 14px',
                borderRadius: 4,
                cursor: pasteBusy || !pasteValue.trim() ? 'default' : 'pointer',
                fontWeight: 600,
              }}
            >
              {pasteBusy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {pasteError && (
            <div style={{ fontSize: 11, color: 'var(--tp-danger)', marginTop: 4 }}>{pasteError}</div>
          )}
        </div>
      )}
    </>
  );
}

function ParkSuggestionGroup({
  label,
  rows,
  readonly,
  accentColor,
  accentBorder,
  onAdd,
  onSetOvernight,
  addingKey,
  mapsHrefForRow,
}: {
  label: string;
  rows: NearbyRow[];
  readonly: boolean;
  accentColor: string;
  accentBorder: string;
  onAdd: (row: NearbyRow) => void;
  /**
   * Optional. When provided, adds an "Add as overnight" primary button
   * next to "Add as rest stop". Only the curated top-pick groups get this
   * — the long "Show more" leftovers don't, to keep the affordance scarce.
   */
  onSetOvernight?: (row: NearbyRow) => void;
  addingKey: string | null;
  mapsHrefForRow: (row: NearbyRow) => string;
}) {
  if (!rows?.length) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 700, marginBottom: 6, color: accentColor }}>
          {label}
        </div>
        <div style={{ fontSize: 11, color: 'var(--tp-subtle)', fontStyle: 'italic' }}>No Places hits in reach.</div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 700, marginBottom: 8, color: accentColor }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row, idx) => {
          const dedupe =
            row.placeId ?? `${row.lat.toFixed(5)}:${row.lng.toFixed(5)}`;
          const mapsHref = mapsHrefForRow(row);
          return (
            <div
              key={`${dedupe}-${idx}`}
              style={{
                paddingTop: idx === 0 ? 0 : 8,
                paddingBottom: idx === rows.length - 1 ? 0 : 8,
                borderTop: idx === 0 ? 'none' : '1px solid var(--tp-border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  gap: 6,
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: idx === 0 ? 600 : 400, color: 'var(--tp-text)' }}>
                    {row.name}
                  </span>{' '}
                  {idx === 0 ? (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: accentColor,
                        border: `1px solid ${accentBorder}`,
                        borderRadius: 3,
                        padding: '2px 5px',
                        marginLeft: 4,
                      }}
                    >
                      Closest
                    </span>
                  ) : null}
                  {!row.within5Km ? (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--tp-muted)',
                        border: '1px solid var(--tp-border)',
                        borderRadius: 3,
                        padding: '2px 5px',
                        marginLeft: 4,
                      }}
                    >
                      Outside 5 km
                    </span>
                  ) : null}
                  <Distance
                    km={row.distanceKm}
                    layout="inline"
                    primaryOverride={`${row.distanceKm.toFixed(1)} km`}
                    style={{ marginLeft: 8, fontSize: 11, color: 'var(--tp-muted)' }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                <a
                  href={mapsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11,
                    padding: '3px 10px',
                    borderRadius: 4,
                    textDecoration: 'none',
                    color: accentColor,
                    border: `1px solid ${accentBorder}`,
                  }}
                >
                  Maps ↗
                </a>
                {!readonly && onSetOvernight && (
                  <button
                    type="button"
                    onClick={() => onSetOvernight(row)}
                    disabled={addingKey !== null}
                    style={{
                      fontSize: 11,
                      padding: '3px 10px',
                      borderRadius: 4,
                      cursor: addingKey !== null ? 'wait' : 'pointer',
                      background: 'var(--tp-primary)',
                      border: '1px solid var(--tp-primary)',
                      color: 'var(--tp-on-primary)',
                      fontWeight: 600,
                    }}
                  >
                    {addingKey === dedupe ? 'Adding…' : 'Use as overnight'}
                  </button>
                )}
                {!readonly && (
                  <button
                    type="button"
                    onClick={() => onAdd(row)}
                    disabled={addingKey !== null}
                    style={{
                      fontSize: 11,
                      padding: '3px 10px',
                      borderRadius: 4,
                      cursor: addingKey !== null ? 'wait' : 'pointer',
                      background: 'rgba(124,181,232,0.18)',
                      border: '1px solid rgba(124,181,232,0.35)',
                      color: 'var(--tp-primary)',
                    }}
                  >
                    {addingKey === dedupe ? 'Adding…' : 'Add as rest stop'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StopGroup({
  type,
  stops,
  onSelect,
  onDismiss,
  onDelete,
  onSwapAlternate,
  readonly,
}: {
  type: StopType;
  stops: Stop[];
  onSelect: (id: number) => void;
  onDismiss: (id: number) => void;
  onDelete: (id: number) => void;
  onSwapAlternate?: (id: number, altIndex: number) => void;
  readonly: boolean;
}) {
  const meta = TYPE_META[type];
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 10,
          color: meta.color,
          letterSpacing: '0.08em',
          marginBottom: 4,
        }}
      >
        {meta.icon} {meta.label.toUpperCase()}
      </div>
      {stops.map((s) => (
        <StopRow
          key={s.id}
          stop={s}
          onSelect={onSelect}
          onDismiss={onDismiss}
          onDelete={onDelete}
          onSwapAlternate={onSwapAlternate}
          readonly={readonly}
        />
      ))}
    </div>
  );
}

function StopRow({
  stop,
  onSelect,
  onDismiss,
  onDelete,
  onSwapAlternate,
  readonly,
}: {
  stop: Stop;
  onSelect: (id: number) => void;
  onDismiss: (id: number) => void;
  onDelete: (id: number) => void;
  onSwapAlternate?: (id: number, altIndex: number) => void;
  readonly: boolean;
}) {
  const selected = stop.status === 'selected';
  const dismissed = stop.status === 'dismissed';
  const hasCoords = stop.lat != null && stop.lng != null;
  const [copied, setCopied] = useState(false);
  // Auto-fuel rows from src/server/fuel.ts persist up to 2 alternate
  // gas-station candidates so the user can swap without us round-tripping
  // Google. Only show the dropdown for fuel rows (rest auto-stretch rows
  // currently come with no alternates).
  const hasSwapOptions =
    !readonly &&
    !dismissed &&
    stop.stop_type === 'fuel' &&
    stop.alternatives != null &&
    stop.alternatives.length > 0 &&
    onSwapAlternate != null;

  async function handleCopyCoords() {
    if (!hasCoords) return;
    const text = `${stop.lat},${stop.lng}`;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 0',
        fontSize: 12,
        color: dismissed ? 'var(--tp-subtle)' : 'var(--tp-text)',
        borderTop: '1px solid var(--tp-border)',
        opacity: dismissed ? 0.6 : 1,
      }}
    >
      {!readonly && !dismissed && (
        <button
          onClick={() => onSelect(stop.id)}
          title={selected ? 'Selected — included as a waypoint' : 'Select this stop'}
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `1.5px solid ${selected ? 'var(--tp-success)' : 'var(--tp-border-strong)'}`,
            background: selected ? 'var(--tp-success)' : 'transparent',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        />
      )}
      {(readonly || dismissed) && (
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `1.5px solid ${selected ? 'var(--tp-success)' : 'var(--tp-border)'}`,
            background: selected ? 'var(--tp-success)' : 'transparent',
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span
            style={{
              fontWeight: selected ? 600 : 400,
              color: selected ? 'var(--tp-text)' : 'inherit',
              textDecoration: dismissed ? 'line-through' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {stop.name}
          </span>
          {stop.distance_from_start_km != null && (
            <Distance
              km={stop.distance_from_start_km}
              layout="inline"
              primaryOverride={`~${stop.distance_from_start_km} km`}
              style={{ fontSize: 10, color: 'var(--tp-muted)' }}
            />
          )}
          {stop.fuel_type && (
            <span style={{ fontSize: 10, color: 'var(--tp-muted)' }}>{stop.fuel_type}</span>
          )}
        </div>
        {(stop.notes || stop.source_url) && (
          <div style={{ fontSize: 10, color: 'var(--tp-subtle)', marginTop: 2 }}>
            {stop.notes ? <span>{stop.notes}</span> : null}
            {stop.source_url ? (
              <>
                {stop.notes ? ' · ' : null}
                <a
                  href={stop.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                >
                  {stop.source || 'source'} →
                </a>
              </>
            ) : null}
          </div>
        )}
      </div>
      {hasCoords && (
        <button
          onClick={handleCopyCoords}
          title="Copy GPS coordinates to clipboard (paste into iOverlander, Park4Night, or any map app)"
          style={{
            fontSize: 10,
            background: 'transparent',
            border: '1px solid var(--tp-border)',
            color: copied ? 'var(--tp-success)' : 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          {copied ? '✓ Copied' : '📋 GPS'}
        </button>
      )}
      {hasSwapOptions && stop.alternatives && (
        <select
          aria-label="Swap to a different gas station"
          title="Swap to a different gas station nearby"
          // Reset the select back to the placeholder after every change so
          // the user can re-open it and pick again. We treat the select
          // purely as a one-shot menu — the row's actual primary lives in
          // stop.name above.
          value=""
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            if (Number.isNaN(idx)) return;
            onSwapAlternate?.(stop.id, idx);
            e.currentTarget.value = '';
          }}
          style={{
            fontSize: 10,
            background: 'transparent',
            border: '1px solid var(--tp-border)',
            color: 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 4px',
            borderRadius: 3,
            flexShrink: 0,
            maxWidth: 110,
          }}
        >
          <option value="" disabled>
            ▾ Swap
          </option>
          {stop.alternatives.map((alt, idx) => (
            <option key={`${alt.place_id ?? idx}`} value={idx}>
              {alt.name} ({alt.distance_km.toFixed(1)} km)
            </option>
          ))}
        </select>
      )}
      {hasCoords && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Preview on Google Maps"
          style={{
            fontSize: 10,
            color: 'rgba(124,181,232,0.7)',
            textDecoration: 'none',
            padding: '2px 6px',
            flexShrink: 0,
          }}
        >
          map ↗
        </a>
      )}
      {!readonly && !dismissed && (
        <button
          onClick={() => onDismiss(stop.id)}
          title="Dismiss (keeps it for reference)"
          style={{
            fontSize: 10,
            background: 'transparent',
            border: 'none',
            color: 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 4px',
          }}
        >
          dismiss
        </button>
      )}
      {!readonly && (
        <button
          onClick={() => onDelete(stop.id)}
          title="Delete"
          style={{
            fontSize: 14,
            background: 'transparent',
            border: 'none',
            color: 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 6px',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
