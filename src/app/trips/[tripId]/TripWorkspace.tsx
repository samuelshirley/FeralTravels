'use client';

import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from 'react';
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
import { reverseGeocode } from '@/lib/reverseGeocode';
import {
  DeviceLocationProvider,
  useDeviceLocation,
} from '@/components/DeviceLocationContext';
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
  /** When true, auto-opens chat with a Penny replan prompt (from off-route email deep link). */
  replanFromOffRoute?: boolean;
}

// Reserve room for the fixed bottom nav on mobile so the inner pane scrolls
// don't end up under the nav. Equals nav height (~70px after the 2026-05
// taller-touch-target tweak) plus iPhone home indicator safe area.
const MOBILE_BOTTOM_NAV_HEIGHT = 70;

const ITINERARY_LIST_PADDING = '20px 16px';
const ITINERARY_LIST_PADDING_MOBILE = '16px 12px';

/** Scroll container for the itinerary pane — padding lives on an inner wrapper
 *  so the bottom inset (from Itinerary's scroll-end spacer) is always reachable. */
const ItineraryListScroller = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'> & { padding?: string }
>(function ItineraryListScroller(
  { children, padding = ITINERARY_LIST_PADDING, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      style={{
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--tp-bg)',
        WebkitOverflowScrolling: 'touch',
        ...style,
      }}
    >
      <div style={{ padding }}>{children}</div>
    </div>
  );
});

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

export default function TripWorkspace(props: Props) {
  // The provider owns the app's single geolocation pipeline: the one on-load
  // prompt, the live position watch, and the permission-change subscription.
  // Everything below (the position report + every leg card's smart nav)
  // consumes the shared position instead of calling the Geolocation API.
  return (
    <DeviceLocationProvider promptAllowed={!props.readonly}>
      <TripWorkspaceInner {...props} />
    </DeviceLocationProvider>
  );
}

function TripWorkspaceInner({
  tripId,
  serverTrip,
  readonly,
  user,
  isAdmin = false,
  initialChat,
  serverOnboardingState,
  replanFromOffRoute = false,
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
  // Drives "open this in the list view": set when the user clicks a leg or stop
  // marker on the map. The nonce makes repeated clicks on the same target
  // re-fire the Itinerary's expand+scroll effect. stopId is null for a leg
  // click (open the day) or set for a stop click (scroll to that stop).
  const [focusTarget, setFocusTarget] = useState<{
    legId: string;
    stopId: string | null;
    nonce: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [trailsVersion, setTrailsVersion] = useState(0);

  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [thinking, setThinking] = useState(false);
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

  // Report the user's GPS position once per workspace mount, from the shared
  // DeviceLocationProvider (which owns the ONE deliberate location prompt and
  // the live watch). Fires on the first position fix — whether that fix
  // arrived immediately (permission already granted) or after the user
  // answered the on-load prompt. Fire-and-forget — never block the UI;
  // denial just means no position report.
  const { position: devicePosition } = useDeviceLocation();
  const positionReportedRef = useRef(false);
  useEffect(() => {
    if (readonly || !devicePosition || positionReportedRef.current) return;
    positionReportedRef.current = true;
    const { lat, lng } = devicePosition;
    // Best-effort reverse-geocode to a readable label so Penny can name the
    // driver's current location instead of reciting coordinates. Never block
    // the position report on it — post coords immediately if it misses.
    void (async () => {
      let place: string | null = null;
      try {
        place = await reverseGeocode(lat, lng);
      } catch {
        place = null;
      }
      fetch(`/api/trips/${tripId}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, place_name: place }),
        credentials: 'same-origin',
      }).catch(() => {
        // Silently ignore — position reporting is best-effort.
      });
    })();
  }, [tripId, readonly, devicePosition]);

  // Auto-open chat and switch to chat tab when arriving from the off-route
  // email deep link (?replan=true). Runs once on mount.
  const replanHandled = useRef(false);
  useEffect(() => {
    if (!replanFromOffRoute || replanHandled.current) return;
    replanHandled.current = true;
    // On mobile, switch to the chat tab
    setMobileTab('chat');
  }, [replanFromOffRoute]);

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

  // Clicking a marker on the map opens that day/stop in the list view. On mobile
  // that means switching to the list tab; on desktop the list pane is already
  // visible, so we just expand + scroll it (handled inside Itinerary). We also
  // keep selectedLegId in sync so the map pans/highlights the same leg.
  const focusInList = useCallback(
    (legId: string, stopId: string | null) => {
      setSelectedLegId(legId);
      setFocusTarget({ legId, stopId, nonce: Date.now() });
      if (viewport === 'mobile') setMobileTab('list');
    },
    [viewport],
  );

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
  // Lazy fuel sourcing (2026-06 architectural fix).
  //
  // There is no eager, trip-wide fuel replan anymore — that debounced fingerprint
  // diff was the Google Places cost sink (every leg edit re-planned the whole
  // trip). Each day now sources its OWN fuel lazily when the user opens it (see
  // LegCard's day-open effect → POST /api/legs/:id/fuel-stops), and leg
  // edits / report_position invalidate only the affected leg's cache server-side.
  // The transient per-leg 'computing' status is still reflected by the poll
  // effect above and the tripFuelBusy spinner below.
  // ---------------------------------------------------------------------------

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
    if (evt === 'response' || evt === 'error') {
      // Chat is permanently visible on tablet & desktop — only mobile needs an
      // unread badge, and only when the user is on a non-chat tab.
      const isOnChat =
        viewport === 'mobile' ? mobileTabRef.current === 'chat' : true;
      if (!isOnChat) setUnread((u) => u + 1);
    }
  };

  // Hoisted above the pane definitions because itineraryPane needs to know
  // the fuel-syncing state to render its Maps-link affordance. Fuel is now
  // sourced lazily per day, so the only "busy" signal is a leg whose own
  // day-open search is mid-flight (transient 'computing'/'pending' status).
  const tripFuelBusy = trip.legs.some(
    (l) => l.fuel_status === 'computing' || l.fuel_status === 'pending',
  );

  const mapPane = (
    <TripMap
      legs={trip.legs}
      pois={pois}
      selectedLegId={selectedLegId}
      onLegSelect={(id) => focusInList(id, null)}
      onStopSelect={(legId, stopId) => focusInList(legId, stopId)}
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
      // While a leg's day-open fuel search is in flight, its Maps link shows a
      // syncing affordance so users don't click a URL missing the just-found
      // stops. `tripFuelBusy` covers any leg whose fuel_status is
      // computing/pending.
      isFuelSyncing={tripFuelBusy}
      // Map marker clicks open the owning day/stop here (expand + scroll).
      focusTarget={focusTarget}
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
      onTripUpdated={loadTrip}
      onActivity={handleChatActivity}
      readonly={readonly}
    />
  );

  // The chip shows a quiet "Fuel…" indicator while a leg's day-open fuel
  // search is in flight so the user knows why a moment of latency is
  // happening. On mobile we hide the label and keep only the spinner to save
  // header width.
  const vehicleChip = !readonly ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {tripFuelBusy && (
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
          // Use position:fixed instead of height:100dvh so that iOS Safari
          // cannot scroll the page when the soft keyboard opens — this keeps
          // the AppNavbar pinned at the top at all times.
          position: 'fixed',
          inset: 0,
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
          <ItineraryListScroller
            ref={setMobileListEl}
            padding={ITINERARY_LIST_PADDING_MOBILE}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: `calc(${MOBILE_BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
              display: mobileTab === 'list' ? 'block' : 'none',
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
          </ItineraryListScroller>
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
                  <ItineraryListScroller>{itineraryPane}</ItineraryListScroller>
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
            <ItineraryListScroller>{itineraryPane}</ItineraryListScroller>
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
