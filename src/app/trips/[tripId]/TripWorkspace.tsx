'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import Itinerary from '@/components/Itinerary';
import ChatPanel from '@/components/ChatPanel';
import AppNavbar from '@/components/AppNavbar';
import BottomNav, { type MobileTab } from '@/components/BottomNav';
import { useIsMobile } from '@/lib/useMediaQuery';
import { tripApi } from '@/lib/api';
import type { TripWithLegs, POI } from '@/types/trip';

const TripMap = dynamic(() => import('@/components/TripMap'), { ssr: false });

interface Props {
  tripId: number;
  readonly: boolean;
  user: { name?: string | null; email?: string | null; image?: string | null };
}

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

export default function TripWorkspace({ tripId, readonly, user }: Props) {
  const api = tripApi(tripId);
  const isMobile = useIsMobile();

  const [trip, setTrip] = useState<TripWithLegs | null>(null);
  const [pois, setPois] = useState<POI[]>([]);
  const [selectedLegId, setSelectedLegId] = useState<number | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [trailsVersion, setTrailsVersion] = useState(0);

  // Mobile-only state
  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [thinking, setThinking] = useState(false);
  const [unread, setUnread] = useState(0);
  const mobileTabRef = useRef<MobileTab>(mobileTab);
  mobileTabRef.current = mobileTab;

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

  // When user opens chat tab on mobile, clear unread
  useEffect(() => {
    if (mobileTab === 'chat') setUnread(0);
  }, [mobileTab]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar user={user} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 14,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Loading trip…
        </div>
      </div>
    );
  }

  if (!trip) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar user={user} />
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
        if (isMobile) setMobileTab('map');
      }}
      onTrailsChanged={() => setTrailsVersion((v) => v + 1)}
      onChanged={loadTrip}
      readonly={readonly}
    />
  );

  const chatPane = (
    <ChatPanel
      tripId={tripId}
      initialMessages={[]}
      onTripUpdated={loadTrip}
      onActivity={(evt) => {
        setThinking(evt === 'thinking');
        if (evt === 'response' && mobileTabRef.current !== 'chat') {
          setUnread((u) => u + 1);
        }
      }}
      readonly={readonly}
    />
  );

  if (isMobile) {
    return (
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <AppNavbar user={user} tripName={trip.name} />
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: mobileTab === 'map' ? 'block' : 'none',
            }}
          >
            {mapPane}
          </div>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflowY: 'auto',
              padding: '16px 12px',
              background: 'rgba(13,13,13,0.6)',
              display: mobileTab === 'list' ? 'block' : 'none',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {itineraryPane}
          </div>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: mobileTab === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              background: '#0D0D0D',
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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={user}
        tripName={trip.name}
        rightSlot={
          <button
            onClick={() => setChatOpen((v) => !v)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: chatOpen ? 'rgba(124,232,163,0.2)' : 'rgba(255,255,255,0.06)',
              color: chatOpen ? '#7CE8A3' : 'rgba(255,255,255,0.5)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            title="Toggle chat panel"
          >
            {chatOpen ? 'Chat ×' : 'Chat +'}
          </button>
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
