'use client';

import { useState } from 'react';
import StopCard from './StopCard';
import Spinner from '../Spinner';

export type SearchMode = 'along-route' | 'near-destination';

export interface NearbyStopSuggestion {
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  googleMapsUri: string | null;
  placeId: string | null;
  photos?: Array<{ url: string; attribution?: string }>;
}

export interface MoreStopsData {
  fuel: NearbyStopSuggestion[];
  groceries: NearbyStopSuggestion[];
  water: NearbyStopSuggestion[];
  parks: NearbyStopSuggestion[];
}

export interface MoreStopsModalProps {
  isOpen: boolean;
  onClose: () => void;
  legLabel: string;
  stops: MoreStopsData;
  loading: boolean;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
}

type TabKey = keyof MoreStopsData;

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'fuel', label: 'Fuel', icon: '⛽' },
  { key: 'groceries', label: 'Groceries', icon: '🛒' },
  { key: 'water', label: 'Water fill', icon: '💧' },
  { key: 'parks', label: 'Parks', icon: '🌳' },
];

export default function MoreStopsModal({
  isOpen,
  onClose,
  legLabel,
  stops,
  loading,
  searchMode,
  onSearchModeChange,
}: MoreStopsModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('fuel');

  if (!isOpen) return null;

  const currentStops = stops[activeTab];

  const stopTypeMap: Record<TabKey, 'fuel' | 'food' | 'water' | 'rest'> = {
    fuel: 'fuel',
    groceries: 'food',
    water: 'water',
    parks: 'rest',
  };

  return (
    <div
      data-testid="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(51,51,51,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--tp-surface)',
          borderRadius: '16px 16px 0 0',
          width: '100%',
          maxWidth: 480,
          maxHeight: '85vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'tp-slide-up 0.25s ease-out',
        }}
      >
        {/* Handle */}
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            background: 'var(--tp-border-strong)',
            margin: '10px auto 0',
          }}
        />

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px 8px',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--tp-text)' }}>
            More stops — {legLabel}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              fontSize: 18,
              color: 'var(--tp-muted)',
              cursor: 'pointer',
              padding: '4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 6,
            padding: '0 16px 10px',
            overflowX: 'auto',
          }}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: 600,
                  border: `1px solid ${isActive ? 'var(--tp-text)' : 'var(--tp-border)'}`,
                  background: isActive ? 'var(--tp-text)' : 'transparent',
                  color: isActive ? 'var(--tp-surface)' : 'var(--tp-muted)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s',
                }}
              >
                {tab.icon} {tab.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ padding: '0 16px 16px', overflowY: 'auto', flex: 1 }}>
          {/* Search mode toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--tp-subtle)',
              marginBottom: 8,
              paddingBottom: 6,
              borderBottom: '1px solid var(--tp-border)',
            }}
          >
            <span>📍</span>
            <span>Showing stops {searchMode === 'along-route' ? 'along route' : 'near destination'}</span>
            <div
              style={{
                display: 'flex',
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
                overflow: 'hidden',
                marginLeft: 'auto',
              }}
            >
              <button
                onClick={() => onSearchModeChange('along-route')}
                style={{
                  padding: '3px 10px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  background: searchMode === 'along-route' ? 'var(--tp-primary-muted)' : 'transparent',
                  color: searchMode === 'along-route' ? 'var(--tp-primary)' : 'var(--tp-muted)',
                }}
              >
                Along route
              </button>
              <button
                onClick={() => onSearchModeChange('near-destination')}
                style={{
                  padding: '3px 10px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  background: searchMode === 'near-destination' ? 'var(--tp-primary-muted)' : 'transparent',
                  color: searchMode === 'near-destination' ? 'var(--tp-primary)' : 'var(--tp-muted)',
                }}
              >
                Near dest.
              </button>
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 12,
                fontSize: 12,
                color: 'var(--tp-muted)',
              }}
            >
              <Spinner size={12} thickness={2} color="var(--tp-primary)" />
              Loading nearby places…
            </div>
          )}

          {/* Stop list */}
          {!loading && currentStops.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '12px 0' }}>
              No stops found in this category along your route.
            </div>
          )}

          {!loading &&
            currentStops.map((stop) => (
              <StopCard
                key={stop.placeId ?? `${stop.lat}:${stop.lng}`}
                stopType={stopTypeMap[activeTab]}
                name={stop.name}
                distanceFromStartKm={stop.distanceKm}
                photos={stop.photos ?? []}
                googleMapsUri={stop.googleMapsUri}
                lat={stop.lat}
                lng={stop.lng}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
