'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegWithDetails } from '@/types/trip';
import { tripApi } from '@/lib/api';
import StatusBadge from './StatusBadge';
import RoutesSection from './RoutesSection';
import TasksSection from './TasksSection';
import FindOvernightDrawer from './FindOvernightDrawer';

interface LegCardProps {
  tripId: number;
  leg: LegWithDetails;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  onTrailsChanged?: () => void;
  onChanged?: () => void;
  readonly?: boolean;
}

interface AttachedTrail {
  id: number;
  name: string;
  source: string | null;
  source_url: string | null;
  surface: string | null;
  distance_km: number | null;
}

export default function LegCard({
  tripId,
  leg,
  expanded,
  onToggle,
  onNavigate,
  onTrailsChanged,
  onChanged,
  readonly = false,
}: LegCardProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const driveHours = leg.drive_time_minutes ? (leg.drive_time_minutes / 60).toFixed(1) : null;
  const totalCost = leg.costs.find((c) => c.is_total);
  const itemCosts = leg.costs.filter((c) => !c.is_total);

  const [trails, setTrails] = useState<AttachedTrail[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [overnightOpen, setOvernightOpen] = useState(false);

  const loadTrails = async () => {
    try {
      const data = await api.listGpxForLeg(leg.id);
      if (Array.isArray(data)) {
        setTrails(
          (data as any[]).map((t) => ({
            id: t.id,
            name: t.name,
            source: t.source,
            source_url: t.source_url,
            surface: t.surface,
            distance_km: t.distance_km,
          }))
        );
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (expanded) loadTrails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, leg.id]);

  const handleUpload = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      await api.uploadGpx(leg.id, file, file.name.replace(/\.gpx$/i, ''));
      await loadTrails();
      onTrailsChanged?.();
    } catch (err: any) {
      setUploadError(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteTrail = async (trailId: number) => {
    try {
      await api.deleteGpx(trailId);
      await loadTrails();
      onTrailsChanged?.();
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        marginBottom: 2,
        background: expanded ? 'rgba(255,255,255,0.04)' : 'transparent',
        borderRadius: 8,
        overflow: 'hidden',
        transition: 'background 0.2s',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 16px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: leg.color || '#7CB5E8',
            flexShrink: 0,
            boxShadow: `0 0 8px ${leg.color || '#7CB5E8'}40`,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: 'rgba(255,255,255,0.3)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {leg.label}
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{leg.title}</span>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 3, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.4)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {leg.dates}
            </span>
            {leg.distance_km ? (
              <span
                style={{
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.25)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {leg.distance_km} km
              </span>
            ) : null}
            {driveHours ? (
              <span
                style={{
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.25)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {driveHours} hrs
              </span>
            ) : null}
          </div>
        </div>
        <StatusBadge status={leg.status} />
        <span
          style={{
            color: 'rgba(255,255,255,0.3)',
            fontSize: 18,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.2s',
          }}
        >
          ▾
        </span>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px 40px' }}>
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.3)',
                  fontFamily: "'JetBrains Mono', monospace",
                  marginBottom: 2,
                }}
              >
                TERRAIN
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{leg.terrain}</div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.3)',
                  fontFamily: "'JetBrains Mono', monospace",
                  marginBottom: 2,
                }}
              >
                OVERNIGHT
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{leg.overnight}</div>
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            {leg.parsedNotes.map((note: string, i: number) => (
              <div
                key={i}
                style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.55)',
                  lineHeight: 1.5,
                  padding: '3px 0 3px 12px',
                  borderLeft: '2px solid rgba(255,255,255,0.06)',
                  marginBottom: 2,
                }}
              >
                {note}
              </div>
            ))}
          </div>

          <RoutesSection
            tripId={tripId}
            legId={leg.id}
            legCoords={{
              start_lat: leg.start_lat,
              start_lng: leg.start_lng,
              end_lat: leg.end_lat,
              end_lng: leg.end_lng,
            }}
            initialRoutes={leg.routes}
            onChanged={onChanged}
            onTrailsChanged={onTrailsChanged}
            readonly={readonly}
          />

          {!readonly && leg.start_lat != null && leg.start_lng != null && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOvernightOpen(true);
              }}
              style={{
                marginTop: 8,
                width: '100%',
                fontSize: 12,
                background: 'rgba(232,213,124,0.08)',
                border: '1px dashed rgba(232,213,124,0.35)',
                color: '#E8D57C',
                padding: '8px 12px',
                borderRadius: 5,
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.05em',
              }}
              title="Search iOverlander, Park4Night, and Google for free overnight spots near this leg"
            >
              ⌂ Find a spot near here
            </button>
          )}

          {overnightOpen && (
            <FindOvernightDrawer
              tripId={tripId}
              legId={leg.id}
              legCoords={{
                start_lat: leg.start_lat,
                start_lng: leg.start_lng,
                end_lat: leg.end_lat,
                end_lng: leg.end_lng,
              }}
              legEndName={leg.end_name}
              onClose={() => setOvernightOpen(false)}
              onAdded={() => {
                onChanged?.();
              }}
            />
          )}

          <div
            style={{
              marginTop: 12,
              padding: '10px 14px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.06)',
            }}
            onDragOver={(e) => {
              if (readonly) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              if (readonly) return;
              e.preventDefault();
              e.stopPropagation();
              const f = Array.from(e.dataTransfer.files).find((file) =>
                file.name.toLowerCase().endsWith('.gpx')
              );
              if (f) handleUpload(f);
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'rgba(255,255,255,0.35)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                TRAILS / GPX
              </div>
              {!readonly && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".gpx,application/gpx+xml,application/xml,text/xml"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    disabled={uploading}
                    style={{
                      fontSize: 11,
                      background: 'rgba(124,181,232,0.15)',
                      border: '1px solid rgba(124,181,232,0.3)',
                      color: '#7CB5E8',
                      padding: '3px 10px',
                      borderRadius: 4,
                      cursor: uploading ? 'default' : 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {uploading ? 'Uploading…' : '+ Add GPX'}
                  </button>
                </div>
              )}
            </div>

            {trails.length === 0 && !uploadError && (
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.35)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {readonly
                  ? 'No trails for this leg.'
                  : 'Drop a .gpx file here, or click + Add GPX. (Wikiloc, TET, Komoot, Gaia exports.)'}
              </div>
            )}

            {uploadError && (
              <div style={{ fontSize: 11, color: '#E8927C', marginBottom: 6 }}>{uploadError}</div>
            )}

            {trails.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 0',
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.7)',
                  borderTop: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name}
                    </span>
                    {t.distance_km != null && (
                      <span
                        style={{
                          fontSize: 10,
                          color: 'rgba(255,255,255,0.4)',
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {t.distance_km} km
                      </span>
                    )}
                  </div>
                  {(t.source || t.source_url) && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'rgba(255,255,255,0.35)',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      {t.source_url ? (
                        <a
                          href={t.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#7CB5E8', textDecoration: 'none' }}
                        >
                          {t.source || 'source'} →
                        </a>
                      ) : (
                        t.source
                      )}
                    </div>
                  )}
                </div>
                {!readonly && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteTrail(t.id);
                    }}
                    style={{
                      fontSize: 11,
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(255,255,255,0.4)',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                    title="Remove trail"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          <TasksSection
            tripId={tripId}
            legId={leg.id}
            initialTasks={leg.tasks}
            onChanged={onChanged}
            readonly={readonly}
          />

          {itemCosts.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 14px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'rgba(255,255,255,0.35)',
                  marginBottom: 6,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                ESTIMATED COSTS
              </div>
              {itemCosts.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13,
                    color: 'rgba(255,255,255,0.6)',
                    padding: '2px 0',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <span>{c.item}</span>
                  <span style={{ color: 'rgba(255,255,255,0.8)' }}>{c.estimate}</span>
                </div>
              ))}
              {totalCost && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    padding: '6px 0 0',
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                    marginTop: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <span>{totalCost.item}</span>
                  <span>{totalCost.estimate}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
