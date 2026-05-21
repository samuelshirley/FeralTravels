'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import Itinerary from '@/components/Itinerary';
import ChatPanel from '@/components/ChatPanel';
import AppNavbar from '@/components/AppNavbar';
import Spinner from '@/components/Spinner';
import BottomNav, { type MobileTab } from '@/components/BottomNav';
import TripVehicleChip from '@/components/TripVehicleChip';
import PullToRefresh from '@/components/PullToRefresh';
import { useViewport } from '@/lib/useMediaQuery';
import { useKeyboardOpen } from '@/lib/useKeyboardOpen';
import { tripApi } from '@/lib/api';
import type { TripWithLegs, POI, ChatMessage, OnboardingState } from '@/types/trip';

const TripMap = dynamic(() => import('@/components/TripMap'), { ssr: false });

interface Props {
  tripId: string;
  /** From RSC `getTripFull` — hydrates navbar chrome before client `/api/trip` resolves. */
  serverTrip: {
    name: string;
    vehicle_id: string | null;
  };
  readonly: boolean;
  user: { name?: string | null; email?: string | null; image?: string | null };
  isAdmin?: boolean;
  initialChat?: { messages: ChatMessage[]; hasMore: boolean };
  serverOnboardingState?: OnboardingState;
  needsVehicleRemediation?: boolean;
}

// Reserve room for the fixed bottom nav on mobile so the inner pane scrolls
// don't end up under the nav. Equals nav height (~70px after the 2026-05
// taller-touch-target tweak) plus iPhone home indicator safe area.
const MOBILE_BOTTOM_NAV_HEIGHT = 70;

function ResizeHandle({ direction = 'horizontal' }: { direction?: 'horizontal' | 'vertical' }) {
  // For a horizontal PanelGroup the handle is a vertical bar (col-resize);
  // for a vertical PanelGroup the handle is a horizontal bar (row-resize).
  const isCol = direction === 'horizontal';
  return (
    <PanelResizeHandle
      style={{
        width: isCol ? 6 : '100%',
        height: isCol ? '100%' : 6,
        background: 'var(--tp-border)',
        position: 'relative',
        cursor: isCol ? 'col-resize' : 'row-resize',
        flexShrink: 0,
        transition: 'background 120ms ease',
      }}
      className="trip-resize-handle"
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: isCol ? 2 : 28,
          height: isCol ? 28 : 2,
          borderRadius: 2,
          background: 'var(--tp-border-strong)',
          pointerEvents: 'none',
        }}
      />
    </PanelResizeHandle>
  );
}

export default function TripWorkspace({
  tripId,
  serverTrip,
  readonly,
  user,
  isAdmin = false,
  initialChat,
  serverOnboardingState,
  needsVehicleRemediation = false,
}: Props) {
  // Memoize so a fresh re-render doesn't yield a new api object reference and
  // re-fire effects that depend on it. This was previously causing an infinite
  // re-fetch loop hammering /api/trip and /api/pois.
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const viewport = useViewport();
  const keyboardOpen = useKeyboardOpen();

  const [trip, setTrip] = useState<TripWithLegs | null>(null);
  const [pois, setPois] = useState<POI[]>([]);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [trailsVersion, setTrailsVersion] = useState(0);

  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [thinking, setThinking] = useState(false);
  const [fuelPlanning, setFuelPlanning] = useState(false);
  const [replanBusy, setReplanBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const mobileTabRef = useRef<MobileTab>(mobileTab);
  mobileTabRef.current = mobileTab;
  // Note: chat is permanently visible on tablet & desktop (no toggle in the
  // header anymore), so chatOpen state is gone. Mobile still uses mobileTab.
  // Host for the mobile itinerary scroller — passed to PullToRefresh so
  // the pull gesture only engages when the itinerary tab is actually at
  // scrollTop=0 (vs the window, which is pinned on mobile).
  const [mobileListEl, setMobileListEl] = useState<HTMLDivElement | null>(null);

  const loadTrip = useCallback(async () => {
    try {
      const [tripData, poisData] = await Promise.all([api.getTrip(), api.listPois()]);
      if (tripData && typeof tripData === 'object' && 'legs' in (tripData as any)) {
        setTrip(tripData as TripWithLegs);
      }
      if (Array.isArray(poisData)) setPois(poisData as POI[]);
    } catch (err) {
      console.error('Failed to load trip:', err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadTrip();
  }, [loadTrip]);

  useEffect(() => {
    if (
      !trip?.legs.some((l) => l.fuel_status === 'computing' || l.fuel_status === 'pending')
    ) {
      return;
    }
    const t = setInterval(() => {
      loadTrip();
    }, 2000);
    return () => clearInterval(t);
  }, [trip, loadTrip]);

  // Handler for pull-to-refresh on mobile. We pad the resolution slightly
  // so the "Refreshing" chip is visible even when the fetch is instant.
  const refreshFromPull = useCallback(async () => {
    await loadTrip();
    await new Promise((r) => setTimeout(r, 250));
  }, [loadTrip]);

  // On tablet & desktop chat is now always visible — no chatOpen toggle to set.
  // On mobile, on a freshly-created trip (no legs yet), chat should be the
  // primary view: the user just got here to plan, not to stare at an empty
  // itinerary. Apply at most once per mount so the user is free to switch
  // tabs manually afterwards.
  const isEmptyTrip = trip != null && trip.legs.length === 0;
  const emptyTripTabAppliedRef = useRef(false);
  useEffect(() => {
    if (viewport !== 'mobile') return;
    if (!isEmptyTrip) return;
    if (emptyTripTabAppliedRef.current) return;
    emptyTripTabAppliedRef.current = true;
    setMobileTab('chat');
  }, [viewport, isEmptyTrip]);

  useEffect(() => {
    // Chat is always visible on tablet & desktop now, so the unread badge is
    // a mobile-only concern. Reset it whenever the user is on the chat tab.
    if (viewport === 'mobile' && mobileTab === 'chat') setUnread(0);
    if (viewport !== 'mobile') setUnread(0);
  }, [mobileTab, viewport]);


  // ---------------------------------------------------------------------------
  // Auto-replan with FORWARD-ONLY scoping.
  //
  // We compute a per-leg fingerprint (start/end coords, distance, user-owned
  // stops). When something changes, we identify the lowest sort_order whose
  // fingerprint differs from the last committed baseline and ask the server
  // to replan from that leg forward — past legs are skipped because the
  // cumulative tank-state math only flows forward.
  //
  // We DELIBERATELY exclude any stop whose `source` is 'google_places' (auto
  // fuel/stretch rows the planner wrote itself) from the fingerprint.
  // Otherwise replan's own output would diff against the prior baseline and
  // schedule another replan — that was the recursive loop that hammered the
  // Google Places API every few seconds.
  //
  // We also no longer track vehicle_id: users don't swap vehicles mid-trip,
  // and treating it as a replan trigger added another way for the loop to
  // re-arm. Real geometry/stop changes are what matter.
  //
  // The committed baseline only advances after a replan completes (or after
  // we observe a no-op state). That means edits made WHILE a replan is in
  // flight are not lost — they accumulate in the baseline diff and trigger a
  // follow-up replan once `replanBusy` clears.
  // ---------------------------------------------------------------------------
  type LegFingerprint = { sortOrder: number; sig: string };

  const legFingerprints = useMemo<LegFingerprint[]>(() => {
    if (!trip) return [];
    return trip.legs.map((l) => ({
      sortOrder: l.sort_order,
      sig: JSON.stringify({
        i: l.id,
        sl: l.start_lat,
        sn: l.start_lng,
        el: l.end_lat,
        en: l.end_lng,
        d: l.distance_km,
        s: (l.stops ?? [])
          // Exclude auto fuel/stretch rows the planner wrote itself —
          // including them would make every successful replan re-trigger.
          .filter((s) => s.source !== 'google_places')
          // Exclude options the user hasn't acted on either way; only
          // committed stops (selected/dismissed) and overnights move the
          // route enough to warrant a re-plan.
          .filter((s) => s.status !== 'option' || s.stop_type === 'overnight')
          .map((s) => ({
            t: s.stop_type,
            st: s.status,
            d: s.distance_from_start_km,
          })),
      }),
    }));
  }, [trip]);

  const handleReplanFuelRef = useRef<(start?: number) => Promise<void>>(async () => {});
  const committedLegsRef = useRef<LegFingerprint[] | null>(null);

  useEffect(() => {
    if (readonly) return;
    if (!trip) return;
    // Pause while a replan is mid-flight; we'll re-evaluate on the next render
    // after replanBusy clears (committed baseline still pointing at pre-replan
    // state, so any edits during the flight are preserved as a diff).
    if (replanBusy) return;

    // First observation: establish committed baseline silently.
    if (committedLegsRef.current === null) {
      committedLegsRef.current = legFingerprints;
      return;
    }

    // Diff per-leg fingerprints against committed baseline; find the
    // lowest sort_order that differs. Also catches deletions (a baseline
    // entry whose sort_order no longer exists in the current snapshot).
    const prev = committedLegsRef.current;
    const curMap = new Map(legFingerprints.map((p) => [p.sortOrder, p.sig]));
    const prevMap = new Map(prev.map((p) => [p.sortOrder, p.sig]));
    let minChanged: number | null = null;
    for (const cur of legFingerprints) {
      if (prevMap.get(cur.sortOrder) !== cur.sig) {
        if (minChanged === null || cur.sortOrder < minChanged) {
          minChanged = cur.sortOrder;
        }
      }
    }
    for (const before of prev) {
      if (!curMap.has(before.sortOrder)) {
        if (minChanged === null || before.sortOrder < minChanged) {
          minChanged = before.sortOrder;
        }
      }
    }
    if (minChanged === null) {
      // No change — advance baseline to current snapshot so we don't keep
      // diffing against the pre-replan state forever.
      committedLegsRef.current = legFingerprints;
      return;
    }
    const startFromSortOrder: number = minChanged;

    // Debounce: a burst of edits (drag waypoint, rename leg, swap stop)
    // collapses to one replan. We do NOT update the committed baseline here —
    // we wait until the replan completes successfully. Edits arriving inside
    // the window cancel this timeout and reschedule.
    const t = setTimeout(() => {
      void handleReplanFuelRef.current(startFromSortOrder);
    }, 3000);
    return () => clearTimeout(t);
  }, [legFingerprints, readonly, trip, replanBusy]);

  const effectiveOnboardingState: OnboardingState =
    trip?.onboarding_state ?? serverOnboardingState ?? 'not_started';

  const loadingNavbarRightSlot = !readonly ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <TripVehicleChip
        tripId={tripId}
        initialVehicleId={serverTrip.vehicle_id}
        readonly={readonly}
        onTripUpdated={loadTrip}
      />
    </div>
  ) : undefined;

  if (loading) {
    return (
      <>
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar
          user={user}
          isAdmin={isAdmin}
          tripName={serverTrip.name}
          rightSlot={loadingNavbarRightSlot}
        />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <Spinner size={36} color="var(--tp-success)" thickness={3} />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 2,
              color: 'var(--tp-muted)',
              fontSize: 13,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            <span>Loading trip</span>
            <span className="loading-dot" style={{ animationDelay: '0ms' }}>.</span>
            <span className="loading-dot" style={{ animationDelay: '160ms' }}>.</span>
            <span className="loading-dot" style={{ animationDelay: '320ms' }}>.</span>
          </div>
        </div>
      </div>
      </>
    );
  }

  if (!trip) {
    return (
      <>

        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar user={user} isAdmin={isAdmin} tripName={serverTrip.name} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--tp-muted)',
          }}
        >
          Trip not found.
        </div>
      </div>
      </>
    );
  }

  const handleChatActivity = (
    evt: 'thinking' | 'response' | 'error' | 'fuel-planning'
  ) => {
    setThinking(evt === 'thinking');
    if (evt === 'fuel-planning') setFuelPlanning(true);
    if (evt === 'response' || evt === 'error') {
      setFuelPlanning(false);
      // Chat is permanently visible on tablet & desktop — only mobile needs an
      // unread badge, and only when the user is on a non-chat tab.
      const isOnChat =
        viewport === 'mobile' ? mobileTabRef.current === 'chat' : true;
      if (!isOnChat) setUnread((u) => u + 1);
    }
  };

  // Hoisted above the pane definitions because itineraryPane needs to know
  // the fuel-syncing state to render its Maps-link affordance.
  const tripFuelBusy =
    fuelPlanning ||
    trip.legs.some((l) => l.fuel_status === 'computing' || l.fuel_status === 'pending');

  const mapPane = (
    <TripMap
      legs={trip.legs}
      pois={pois}
      selectedLegId={selectedLegId}
      onLegSelect={setSelectedLegId}
      trailsVersion={trailsVersion}
      tripId={tripId}
    />
  );

  const itineraryPane = (
    <Itinerary
      tripId={tripId}
      trip={trip}
      onLegSelect={(id) => {
        setSelectedLegId(id);
        if (viewport === 'mobile') setMobileTab('map');
      }}
      onTrailsChanged={() => setTrailsVersion((v) => v + 1)}
      onChanged={loadTrip}
      readonly={readonly}
      // While auto-replan is in flight, leg-level Maps links show a syncing
      // affordance so users don't click a stale URL. `tripFuelBusy` covers
      // any leg whose fuel_status is computing/pending; `replanBusy` covers
      // the workspace-level POST /fuel-stops/replan call.
      isFuelSyncing={tripFuelBusy || replanBusy}
    />
  );

  const chatPane = (
    <ChatPanel
      tripId={tripId}
      initialMessages={initialChat?.messages ?? []}
      initialHasMore={initialChat?.hasMore ?? false}
      // When a trip hasn't finished onboarding, ChatPanel swaps its composer
      // for trip-setup questions in ChatPanel. Defaulting to 'done' on readonly /
      // demo trips is safe because ChatPanel also guards on `!readonly`.
      onboardingState={trip.onboarding_state}
      needsVehicleRemediation={needsVehicleRemediation}
      onTripUpdated={loadTrip}
      onActivity={handleChatActivity}
      readonly={readonly}
    />
  );

  async function handleReplanFuel(startFromSortOrder?: number) {
    if (replanBusy || tripFuelBusy) return;
    // Snapshot the fingerprints we're about to commit. After the replan
    // succeeds we promote this snapshot to the committed baseline so the
    // diff doesn't re-fire forever (the replan itself only mutates
    // google_places stops, which the fingerprint excludes — without this
    // promotion the effect kept re-detecting the same minChanged and
    // rescheduled a new replan every 3s in an infinite loop).
    const snapshot = legFingerprints;
    setReplanBusy(true);
    try {
      await api.replenishFuelStops(
        startFromSortOrder !== undefined ? { startFromSortOrder } : undefined,
      );
      await loadTrip();
      committedLegsRef.current = snapshot;
    } catch (e) {
      console.warn('replan fuel failed', e);
    } finally {
      setReplanBusy(false);
    }
  }
  // Bind the latest closure so the auto-replan effect (declared above the
  // early returns) always invokes the current implementation.
  handleReplanFuelRef.current = handleReplanFuel;

  // Replan is now automatic (debounced useEffect below). The chip just shows
  // a quiet "Fuel…" indicator while a replan is in flight so the user knows
  // why a moment of latency is happening. On mobile we hide the label and
  // keep only the spinner to save header width.
  const vehicleChip = !readonly ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {(tripFuelBusy || replanBusy) && (
        <span
          title="Refreshing fuel stops along your route"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--tp-muted)',
            whiteSpace: 'nowrap',
          }}
        >
          <Spinner size={14} thickness={2} color="var(--tp-gold)" />
          {viewport !== 'mobile' && <span>Fuel…</span>}
        </span>
      )}
      <TripVehicleChip
        tripId={tripId}
        initialVehicleId={trip.vehicle_id ?? null}
        readonly={readonly}
        onTripUpdated={loadTrip}
      />
    </div>
  ) : null;

  // ───────── MOBILE (<768px): single pane + fixed bottom nav ─────────
  if (viewport === 'mobile') {
    return (
      <>

        <div
        style={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <AppNavbar user={user} tripName={trip.name} isAdmin={isAdmin} rightSlot={vehicleChip} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            boxSizing: 'border-box',
          }}
        >
          {/*
            Each tab pane uses an explicit `bottom` offset (not paddingBottom)
            so an absolutely-positioned child with height:100% truly fits
            ABOVE the fixed bottom nav. Previous version used paddingBottom,
            which left the chat textarea rendered behind the nav and
            unreachable on mobile.
          */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: `calc(${MOBILE_BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
              display: mobileTab === 'map' ? 'block' : 'none',
            }}
          >
            {mapPane}
          </div>
          <div
            ref={setMobileListEl}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: `calc(${MOBILE_BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
              overflowY: 'auto',
              padding: '16px 12px',
              background: 'var(--tp-bg)',
              display: mobileTab === 'list' ? 'block' : 'none',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {/*
              PullToRefresh attaches its listeners to the mobile list
              scroller (not window). `disabled` when we're not on the
              list tab so pulls inside the chat or map pane don't
              trigger a refresh.
            */}
            <PullToRefresh
              scrollContainer={mobileListEl}
              onRefresh={refreshFromPull}
              disabled={mobileTab !== 'list'}
            >
              {itineraryPane}
            </PullToRefresh>
          </div>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: keyboardOpen
                ? 0
                : `calc(${MOBILE_BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
              display: mobileTab === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              background: 'var(--tp-surface-muted)',
              minHeight: 0,
            }}
          >
            {chatPane}
          </div>
        </div>
        {!keyboardOpen && (
        <BottomNav
          active={mobileTab}
          onChange={setMobileTab}
          thinking={thinking || tripFuelBusy}
          unread={unread}
        />
        )}
      </div>
      </>
    );
  }

  // ───────── TABLET (768–1023px): map top-left, list top-right, chat bottom ─────────
  // Three panels permanently visible: a horizontal map|itinerary split on top,
  // chat as a resizable bottom panel. No chat toggle in the header — users
  // who want more map/list can drag the bottom panel down. Replaces the
  // previous slide-in ChatDrawer pattern.
  if (viewport === 'tablet') {
    return (
      <>

        <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar
          user={user}
          tripName={trip.name}
          isAdmin={isAdmin}
          rightSlot={vehicleChip}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PanelGroup direction="vertical" autoSaveId={`trip-${tripId}-tablet-v2`}>
            <Panel defaultSize={62} minSize={30} order={1}>
              <PanelGroup direction="horizontal" autoSaveId={`trip-${tripId}-tablet-top`}>
                <Panel defaultSize={45} minSize={25} order={1}>
                  <div style={{ height: '100%', width: '100%' }}>{mapPane}</div>
                </Panel>
                <ResizeHandle />
                <Panel defaultSize={55} minSize={30} order={2}>
                  <div
                    style={{
                      height: '100%',
                      overflowY: 'auto',
                      padding: '20px 16px',
                      background: 'var(--tp-bg)',
                    }}
                  >
                    {itineraryPane}
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>
            <ResizeHandle direction="vertical" />
            <Panel defaultSize={38} minSize={15} order={2}>
              <div
                style={{
                  height: '100%',
                  background: 'var(--tp-surface-muted)',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                {chatPane}
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
      </>
    );
  }

  // ───────── DESKTOP (>=1024px):
  // Chat is permanently visible, so no toggle button in the header. Users who
  // want a wider itinerary can drag the chat panel narrow.
  return (
    <>
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={user}
        tripName={trip.name}
        isAdmin={isAdmin}
        rightSlot={vehicleChip}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PanelGroup direction="horizontal" autoSaveId={`trip-${tripId}-panes-3`}>
          <Panel defaultSize={30} minSize={15} order={1}>
            <div style={{ height: '100%', width: '100%' }}>{mapPane}</div>
          </Panel>

          <ResizeHandle />

          <Panel defaultSize={40} minSize={20} order={2}>
            <div
              style={{
                height: '100%',
                overflowY: 'auto',
                padding: '20px 16px',
                background: 'var(--tp-bg)',
              }}
            >
              {itineraryPane}
            </div>
          </Panel>

          <ResizeHandle />

          <Panel defaultSize={30} minSize={18} order={3}>
            <div
              style={{
                height: '100%',
                background: 'var(--tp-surface-muted)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {chatPane}
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
    </>
  );
}
