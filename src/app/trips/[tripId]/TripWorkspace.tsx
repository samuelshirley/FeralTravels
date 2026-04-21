'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import Itinerary from '@/components/Itinerary';
import ChatPanel from '@/components/ChatPanel';
import AppNavbar from '@/components/AppNavbar';
import Spinner from '@/components/Spinner';
import BottomNav, { type MobileTab } from '@/components/BottomNav';
import ChatDrawer from '@/components/ChatDrawer';
import ChatToggleButton from '@/components/ChatToggleButton';
import TripVehicleChip from '@/components/TripVehicleChip';
import PullToRefresh from '@/components/PullToRefresh';
import { useViewport } from '@/lib/useMediaQuery';
import { tripApi } from '@/lib/api';
import type { TripWithLegs, POI, ChatMessage } from '@/types/trip';

const TripMap = dynamic(() => import('@/components/TripMap'), { ssr: false });

interface Props {
  tripId: number;
  readonly: boolean;
  user: { name?: string | null; email?: string | null; image?: string | null };
  isAdmin?: boolean;
  initialChat?: { messages: ChatMessage[]; hasMore: boolean };
}

// Reserve room for the fixed bottom nav on mobile so the inner pane scrolls
// don't end up under the nav. Equals nav height (~62px) plus iPhone home
// indicator safe area.
const MOBILE_BOTTOM_NAV_HEIGHT = 62;

function ResizeHandle() {
  return (
    <PanelResizeHandle
      style={{
        width: 6,
        background: 'rgba(255,255,255,0.06)',
        position: 'relative',
        cursor: 'col-resize',
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
          width: 2,
          height: 28,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.25)',
          pointerEvents: 'none',
        }}
      />
    </PanelResizeHandle>
  );
}

export default function TripWorkspace({
  tripId,
  readonly,
  user,
  isAdmin = false,
  initialChat,
}: Props) {
  // Memoize so a fresh re-render doesn't yield a new api object reference and
  // re-fire effects that depend on it. This was previously causing an infinite
  // re-fetch loop hammering /api/trip and /api/pois.
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const viewport = useViewport();

  const [trip, setTrip] = useState<TripWithLegs | null>(null);
  const [pois, setPois] = useState<POI[]>([]);
  const [selectedLegId, setSelectedLegId] = useState<number | null>(null);
  const [chatOpen, setChatOpen] = useState(viewport === 'desktop');
  const [loading, setLoading] = useState(true);
  const [trailsVersion, setTrailsVersion] = useState(0);

  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [thinking, setThinking] = useState(false);
  const [unread, setUnread] = useState(0);
  const mobileTabRef = useRef<MobileTab>(mobileTab);
  mobileTabRef.current = mobileTab;
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
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

  // Handler for pull-to-refresh on mobile. We pad the resolution slightly
  // so the "Refreshing" chip is visible even when the fetch is instant.
  const refreshFromPull = useCallback(async () => {
    await loadTrip();
    await new Promise((r) => setTimeout(r, 250));
  }, [loadTrip]);

  // Default chat open on desktop, closed on tablet, controlled by mobileTab on phone.
  // Exception: on a freshly-created trip (no legs yet), chat should be the primary
  // view on every viewport — the user just got here to plan, not to stare at an
  // empty itinerary.
  const isEmptyTrip = trip != null && trip.legs.length === 0;
  const emptyTripTabAppliedRef = useRef(false);
  useEffect(() => {
    if (viewport === 'desktop') setChatOpen(true);
    else if (viewport === 'tablet') setChatOpen(isEmptyTrip);
  }, [viewport, isEmptyTrip]);

  // Once on mobile, if this is the first load of an empty trip, jump straight
  // to the chat tab. Apply at most once per mount so the user is free to
  // switch tabs manually afterwards.
  useEffect(() => {
    if (viewport !== 'mobile') return;
    if (!isEmptyTrip) return;
    if (emptyTripTabAppliedRef.current) return;
    emptyTripTabAppliedRef.current = true;
    setMobileTab('chat');
  }, [viewport, isEmptyTrip]);

  useEffect(() => {
    if (viewport === 'mobile' && mobileTab === 'chat') setUnread(0);
    if (viewport !== 'mobile' && chatOpen) setUnread(0);
  }, [mobileTab, viewport, chatOpen]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar user={user} isAdmin={isAdmin} />
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
          <Spinner size={36} color="#7CE8A3" thickness={3} />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 2,
              color: 'rgba(255,255,255,0.55)',
              fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace",
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
    );
  }

  if (!trip) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar user={user} isAdmin={isAdmin} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.5)',
          }}
        >
          Trip not found.
        </div>
      </div>
    );
  }

  const handleChatActivity = (evt: 'thinking' | 'response' | 'error') => {
    setThinking(evt === 'thinking');
    if (evt === 'response' || evt === 'error') {
      const isOnChat =
        viewport === 'mobile' ? mobileTabRef.current === 'chat' : chatOpenRef.current;
      if (!isOnChat) setUnread((u) => u + 1);
    }
  };

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
    />
  );

  const chatPane = (
    <ChatPanel
      tripId={tripId}
      initialMessages={initialChat?.messages ?? []}
      initialHasMore={initialChat?.hasMore ?? false}
      // When a trip hasn't finished onboarding, ChatPanel swaps its composer
      // for the stepwise OnboardingForm. Defaulting to 'done' on readonly /
      // demo trips is safe because ChatPanel also guards on `!readonly`.
      onboardingState={trip.onboarding_state}
      onTripUpdated={loadTrip}
      onActivity={handleChatActivity}
      readonly={readonly}
    />
  );

  const vehicleChip = !readonly ? (
    <TripVehicleChip
      tripId={tripId}
      initialVehicleId={trip.vehicle_id ?? null}
      readonly={readonly}
    />
  ) : null;

  // ───────── MOBILE (<768px): single pane + fixed bottom nav ─────────
  if (viewport === 'mobile') {
    return (
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
              background: 'rgba(13,13,13,0.6)',
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
              bottom: `calc(${MOBILE_BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
              display: mobileTab === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              background: '#0D0D0D',
              minHeight: 0,
            }}
          >
            {chatPane}
          </div>
        </div>
        <BottomNav
          active={mobileTab}
          onChange={setMobileTab}
          thinking={thinking}
          unread={unread}
        />
      </div>
    );
  }

  // ───────── TABLET (768–1023px): two panes + slide-in chat drawer ─────────
  if (viewport === 'tablet') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar
          user={user}
          tripName={trip.name}
          isAdmin={isAdmin}
          rightSlot={
            <>
              {vehicleChip}
              <ChatToggleButton
                open={chatOpen}
                onClick={() => setChatOpen((v) => !v)}
                thinking={thinking}
                unread={unread}
              />
            </>
          }
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PanelGroup direction="horizontal" autoSaveId={`trip-${tripId}-tablet`}>
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
                  background: 'rgba(13,13,13,0.6)',
                }}
              >
                {itineraryPane}
              </div>
            </Panel>
          </PanelGroup>
        </div>
        <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} widthPct={50}>
          {chatPane}
        </ChatDrawer>
      </div>
    );
  }

  // ───────── DESKTOP (>=1024px): three resizable panes ─────────
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={user}
        tripName={trip.name}
        isAdmin={isAdmin}
        rightSlot={
          <>
            {vehicleChip}
            <ChatToggleButton
              open={chatOpen}
              onClick={() => setChatOpen((v) => !v)}
              thinking={thinking}
              unread={unread}
            />
          </>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId={chatOpen ? `trip-${tripId}-panes-3` : `trip-${tripId}-panes-2`}
        >
          <Panel defaultSize={30} minSize={15} order={1}>
            <div style={{ height: '100%', width: '100%' }}>{mapPane}</div>
          </Panel>

          <ResizeHandle />

          <Panel defaultSize={chatOpen ? 40 : 70} minSize={20} order={2}>
            <div
              style={{
                height: '100%',
                overflowY: 'auto',
                padding: '20px 16px',
                background: 'rgba(13,13,13,0.6)',
              }}
            >
              {itineraryPane}
            </div>
          </Panel>

          {chatOpen && (
            <>
              <ResizeHandle />
              <Panel defaultSize={30} minSize={18} order={3}>
                <div
                  style={{
                    height: '100%',
                    background: '#0D0D0D',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {chatPane}
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
