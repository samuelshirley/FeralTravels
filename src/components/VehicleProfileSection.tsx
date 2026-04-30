'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';

export type VehicleType =
  | '4x4_suv'
  | 'pickup'
  | 'van'
  | 'motorcycle'
  | 'sedan'
  | 'other';

export type VehicleFuelType = 'diesel' | 'petrol' | 'premium' | 'lpg';

export type FuelTimingPref = 'start_of_day' | 'when_low' | 'end_of_day';

const FUEL_TYPE_LABELS: Record<VehicleFuelType, string> = {
  diesel: 'Diesel',
  petrol: 'Petrol / Unleaded',
  premium: 'Premium',
  lpg: 'LPG',
};

const FUEL_TIMING_LABELS: Record<FuelTimingPref, string> = {
  start_of_day: 'Top up first thing',
  when_low: 'Refuel when low',
  end_of_day: 'Refuel near camp at end of day',
};

export interface Vehicle {
  id: number;
  user_id: string;
  name: string;
  is_default: boolean;
  vehicle_type: VehicleType | null;
  notes: string | null;
  height_cm: number | null;
  length_m: number | null;
  weight_kg: number | null;
  fuel_economy_kmpl: number | null;
  real_world_kmpl: number | null;
  fuel_tank_l: number | null;
  fuel_type: VehicleFuelType | null;
  fuel_timing_pref: FuelTimingPref | null;
  max_drive_hours_per_day: number | null;
  max_drive_hours_per_week: number | null;
  max_consecutive_drive_days: number | null;
  freshwater_capacity_l: number | null;
  blackwater_capacity_l: number | null;
  water_refill_days: number | null;
  blackwater_refill_days: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Effective range = tank × economy × 0.8 (flat 20% reserve). This is the
 * distance between fuel stops Penny should target; it's NOT the theoretical
 * range. Using a flat 20% buffer matches what overlanders actually teach
 * ("never let it drop below a fifth of a tank") and removes the
 * fuel_reserve_km field users struggled to estimate.
 */
export const FUEL_BUFFER_FRACTION = 0.2;

export function effectiveRangeKm(
  fuel_economy_kmpl: number | null,
  fuel_tank_l: number | null,
  real_world_kmpl: number | null = null
): number | null {
  // Prefer the user's observed real-world economy when it's set; spec is
  // the fallback. Most overlanding rigs underperform spec by 15–30 % once
  // loaded, so users who care will set this and trust it.
  const effective = real_world_kmpl ?? fuel_economy_kmpl;
  if (!effective || !fuel_tank_l) return null;
  const theoretical = effective * fuel_tank_l;
  return Math.max(0, Math.round(theoretical * (1 - FUEL_BUFFER_FRACTION)));
}

type Draft = Partial<Vehicle> & { name: string };

function emptyDraft(): Draft {
  return {
    name: '',
    vehicle_type: null,
    notes: null,
    height_cm: null,
    length_m: null,
    weight_kg: null,
    fuel_economy_kmpl: null,
    real_world_kmpl: null,
    fuel_tank_l: null,
    fuel_type: null,
    fuel_timing_pref: null,
    max_drive_hours_per_day: null,
    max_drive_hours_per_week: null,
    max_consecutive_drive_days: null,
    freshwater_capacity_l: null,
    blackwater_capacity_l: null,
    water_refill_days: null,
    blackwater_refill_days: null,
  };
}

export default function VehicleProfileSection() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const list = await apiFetch<Vehicle[]>('/api/vehicles');
      setVehicles(list);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load vehicles.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave(draft: Draft, id: number | 'new') {
    if (!draft.name?.trim()) {
      setError('Vehicle name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = sanitize(draft);
      if (id === 'new') {
        await apiFetch('/api/vehicles', { body: payload });
      } else {
        await apiFetch(`/api/vehicles/${id}`, { method: 'PATCH', body: payload });
      }
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this vehicle?')) return;
    setError(null);
    try {
      await apiFetch(`/api/vehicles/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  async function handleSetDefault(id: number) {
    try {
      await apiFetch(`/api/vehicles/${id}`, {
        method: 'PATCH',
        body: { is_default: true },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to set default.');
    }
  }

  return (
    <div>
      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 6,
            background: 'var(--tp-danger-muted)',
            border: '1px solid rgba(198, 93, 74, 0.35)',
            color: 'var(--tp-danger)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {vehicles == null ? (
        <div style={{ fontSize: 13, color: 'var(--tp-muted)' }}>Loading vehicles…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {vehicles.map((v) => (
              <div key={v.id}>
                {editingId === v.id ? (
                  <VehicleForm
                    initial={v}
                    saving={saving}
                    onSave={(d) => handleSave(d, v.id)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <VehicleCard
                    vehicle={v}
                    onEdit={() => setEditingId(v.id)}
                    onDelete={() => handleDelete(v.id)}
                    onSetDefault={() => handleSetDefault(v.id)}
                  />
                )}
              </div>
            ))}
          </div>

          {editingId === 'new' ? (
            <div style={{ marginTop: 12 }}>
              <VehicleForm
                initial={emptyDraft()}
                saving={saving}
                onSave={(d) => handleSave(d, 'new')}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <button
              onClick={() => setEditingId('new')}
              style={{
                marginTop: 12,
                width: '100%',
                padding: '10px 14px',
                background: 'var(--tp-primary-muted)',
                border: '1px dashed rgba(78, 122, 176, 0.45)',
                borderRadius: 8,
                color: 'var(--tp-primary)',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              + Add vehicle
            </button>
          )}
        </>
      )}
    </div>
  );
}

function sanitize(draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { name: draft.name.trim() };
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'name' || k === 'id' || k === 'user_id' || k === 'created_at' || k === 'updated_at') continue;
    if (v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function VehicleCard({
  vehicle,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  vehicle: Vehicle;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const range = effectiveRangeKm(
    vehicle.fuel_economy_kmpl,
    vehicle.fuel_tank_l,
    vehicle.real_world_kmpl
  );
  return (
    <div
      style={{
        border: '1px solid var(--tp-border)',
        borderRadius: 10,
        padding: 14,
        background: 'var(--tp-surface-muted)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15 }}>{vehicle.name}</strong>
          {vehicle.is_default && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                background: 'var(--tp-success-muted)',
                color: 'var(--tp-success)',
                padding: '2px 6px',
                borderRadius: 3,
                
                textTransform: 'uppercase',
              }}
            >
              Default
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!vehicle.is_default && (
            <button onClick={onSetDefault} style={smallBtnStyle('var(--tp-success)')}>
              Set default
            </button>
          )}
          <button onClick={onEdit} style={smallBtnStyle('var(--tp-primary)')}>
            Edit
          </button>
          <button onClick={onDelete} style={smallBtnStyle('var(--tp-danger)')}>
            Delete
          </button>
        </div>
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 8,
          fontSize: 12,
          color: 'var(--tp-muted)',
          
        }}
      >
        {vehicle.height_cm != null && (
          <Stat label="Height" value={`${(vehicle.height_cm / 100).toFixed(2)} m`} />
        )}
        {vehicle.weight_kg != null && <Stat label="Weight" value={`${vehicle.weight_kg} kg`} />}
        {range != null && <Stat label="Range" value={`~${range} km`} />}
        {vehicle.fuel_type && <Stat label="Fuel" value={FUEL_TYPE_LABELS[vehicle.fuel_type]} /> }
        {vehicle.max_drive_hours_per_day != null && (
          <Stat label="Drive/day" value={`${vehicle.max_drive_hours_per_day}h`} />
        )}
        {vehicle.water_refill_days != null && (
          <Stat label="Water" value={`${vehicle.water_refill_days}d`} />
        )}
      </div>
      {vehicle.notes && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.4 }}>
          {vehicle.notes}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: 'var(--tp-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>{' '}
      <span style={{ color: '#fff' }}>{value}</span>
    </div>
  );
}

function smallBtnStyle(accent: string): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '5px 10px',
    background: 'var(--tp-surface-muted)',
    border: '1px solid var(--tp-border)',
    color: accent,
    borderRadius: 6,
    cursor: 'pointer',
    
    letterSpacing: '0.04em',
  };
}

function VehicleForm({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: Draft;
  saving: boolean;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>({ ...initial });

  function num(field: keyof Draft) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.trim();
      setD((p) => ({ ...p, [field]: v === '' ? null : Number(v) }));
    };
  }

  return (
    <div
      style={{
        border: '1px solid rgba(78, 122, 176, 0.35)',
        borderRadius: 10,
        padding: 14,
        background: 'var(--tp-primary-muted)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <FieldGroup title="Identity">
        <Field label="Name" required>
          <input value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="e.g. The Hilux" />
        </Field>
        <Field label="Notes" wide>
          <textarea
            value={d.notes ?? ''}
            onChange={(e) => setD((p) => ({ ...p, notes: e.target.value || null }))}
            placeholder="Anything Penny should know — clearance limits, low-bridge warnings, etc."
            rows={2}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Dimensions">
        <Field label="Height (m)">
          <input
            type="number"
            step="0.01"
            value={d.height_cm != null ? d.height_cm / 100 : ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              setD((p) => ({
                ...p,
                height_cm: v === '' ? null : Math.round(Number(v) * 100),
              }));
            }}
            style={inputStyle}
          />
        </Field>
        <Field label="Weight (kg)">
          <input type="number" value={d.weight_kg ?? ''} onChange={num('weight_kg')} style={inputStyle} />
        </Field>
      </FieldGroup>

      <FuelFieldGroup d={d} setD={setD} />

      <FieldGroup title="Drive limits">
        <Field label="Hours / day">
          <input type="number" step="0.5" value={d.max_drive_hours_per_day ?? ''} onChange={num('max_drive_hours_per_day')} style={inputStyle} />
        </Field>
        <Field label="Hours / week">
          <input type="number" step="0.5" value={d.max_drive_hours_per_week ?? ''} onChange={num('max_drive_hours_per_week')} style={inputStyle} />
        </Field>
        <Field label="Consec. days">
          <input type="number" value={d.max_consecutive_drive_days ?? ''} onChange={num('max_consecutive_drive_days')} style={inputStyle} />
        </Field>
      </FieldGroup>

      <FieldGroup title="Water">
        <Field label="Fresh capacity (L)">
          <input type="number" step="1" value={d.freshwater_capacity_l ?? ''} onChange={num('freshwater_capacity_l')} style={inputStyle} />
        </Field>
        <Field label="Refill (days)">
          <input type="number" value={d.water_refill_days ?? ''} onChange={num('water_refill_days')} style={inputStyle} />
        </Field>
        <Field label="Black capacity (L)">
          <input type="number" step="1" value={d.blackwater_capacity_l ?? ''} onChange={num('blackwater_capacity_l')} style={inputStyle} />
        </Field>
        <Field label="Dump (days)">
          <input type="number" value={d.blackwater_refill_days ?? ''} onChange={num('blackwater_refill_days')} style={inputStyle} />
        </Field>
      </FieldGroup>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--tp-muted)' }}>
        <input
          type="checkbox"
          checked={!!d.is_default}
          onChange={(e) => setD((p) => ({ ...p, is_default: e.target.checked }))}
        />
        Use as my default vehicle
      </label>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ ...primaryBtn, background: 'transparent', color: 'var(--tp-muted)' }}>
          Cancel
        </button>
        <button onClick={() => onSave(d)} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Fuel block with:
 *   - km/L ↔ L/100km unit toggle (non-persistent; DB always stores km/L)
 *   - Fuel type dropdown (so Penny can bias fuel stop suggestions to
 *     diesel-friendly stations etc.)
 *   - Safety reserve in km — how much range we want to have left when we
 *     refuel. Defaults to 50km if left blank.
 *   - Derived "Effective range" readout = (economy × tank) − reserve.
 */
function FuelFieldGroup({
  d,
  setD,
}: {
  d: Draft;
  setD: React.Dispatch<React.SetStateAction<Draft>>;
}) {
  const [unit, setUnit] = useState<'kmpl' | 'l100km'>('kmpl');
  const displayedEconomy = (() => {
    if (d.fuel_economy_kmpl == null) return '';
    if (unit === 'kmpl') return String(d.fuel_economy_kmpl);
    // L/100km = 100 / (km/L)
    return (100 / d.fuel_economy_kmpl).toFixed(1);
  })();
  const displayedRealWorld = (() => {
    if (d.real_world_kmpl == null) return '';
    if (unit === 'kmpl') return String(d.real_world_kmpl);
    return (100 / d.real_world_kmpl).toFixed(1);
  })();

  function handleEconomyChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.trim();
    if (raw === '') {
      setD((p) => ({ ...p, fuel_economy_kmpl: null }));
      return;
    }
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) return;
    const kmpl = unit === 'kmpl' ? val : 100 / val;
    setD((p) => ({ ...p, fuel_economy_kmpl: Number(kmpl.toFixed(3)) }));
  }

  function handleRealWorldChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.trim();
    if (raw === '') {
      setD((p) => ({ ...p, real_world_kmpl: null }));
      return;
    }
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) return;
    const kmpl = unit === 'kmpl' ? val : 100 / val;
    setD((p) => ({ ...p, real_world_kmpl: Number(kmpl.toFixed(3)) }));
  }

  const range = effectiveRangeKm(
    d.fuel_economy_kmpl ?? null,
    d.fuel_tank_l ?? null,
    d.real_world_kmpl ?? null
  );
  // Show which figure the range is built from so users understand why a
  // smaller real-world number changes their plan even when spec is set.
  const rangeBasis = d.real_world_kmpl != null ? 'real-world' : 'spec';

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--tp-muted)',
            
          }}
        >
          Fuel
        </div>
        <div
          role="tablist"
          style={{
            display: 'inline-flex',
            border: '1px solid var(--tp-border)',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          {(['kmpl', 'l100km'] as const).map((u) => (
            <button
              key={u}
              type="button"
              role="tab"
              aria-selected={unit === u}
              onClick={() => setUnit(u)}
              style={{
                fontSize: 10,
                padding: '3px 8px',
                background: unit === u ? 'var(--tp-primary-muted)' : 'transparent',
                color: unit === u ? 'var(--tp-primary)' : 'var(--tp-muted)',
                border: 'none',
                cursor: 'pointer',
                
                letterSpacing: '0.04em',
              }}
            >
              {u === 'kmpl' ? 'km/L' : 'L/100km'}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <Field
          label={unit === 'kmpl' ? 'Spec economy (km/L)' : 'Spec economy (L/100km)'}
        >
          <input
            type="number"
            step="0.1"
            value={displayedEconomy}
            onChange={handleEconomyChange}
            style={inputStyle}
          />
        </Field>
        <Field
          label={unit === 'kmpl' ? 'Real-world (km/L)' : 'Real-world (L/100km)'}
          hint="Optional — what your rig actually gets when loaded for a trip."
        >
          <input
            type="number"
            step="0.1"
            value={displayedRealWorld}
            onChange={handleRealWorldChange}
            style={inputStyle}
          />
        </Field>
        <Field label="Tank (L)">
          <input
            type="number"
            step="0.1"
            value={d.fuel_tank_l ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              setD((p) => ({ ...p, fuel_tank_l: v === '' ? null : Number(v) }));
            }}
            style={inputStyle}
          />
        </Field>
        <Field label="Fuel type">
          <select
            value={d.fuel_type ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setD((p) => ({
                ...p,
                fuel_type: v === '' ? null : (v as VehicleFuelType),
              }));
            }}
            style={inputStyle}
          >
            <option value="">—</option>
            {Object.entries(FUEL_TYPE_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Refuel timing">
          <select
            value={d.fuel_timing_pref ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setD((p) => ({
                ...p,
                fuel_timing_pref: v === '' ? null : (v as FuelTimingPref),
              }));
            }}
            style={inputStyle}
          >
            <option value="">No preference</option>
            {Object.entries(FUEL_TIMING_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div
        style={{
          marginTop: 8,
          padding: '6px 10px',
          background: range != null ? 'var(--tp-success-muted)' : 'var(--tp-surface-muted)',
          border:
            range != null
              ? '1px solid rgba(74, 139, 122, 0.35)'
              : '1px dashed var(--tp-border)',
          borderRadius: 6,
          fontSize: 11,
          color: range != null ? 'var(--tp-success)' : 'var(--tp-muted)',
          
          letterSpacing: '0.02em',
        }}
      >
        {range != null
          ? `Effective range ≈ ${range} km (tank × economy × 0.8 — flat 20% reserve)`
          : 'Effective range: set tank + economy to compute'}
      </div>
    </div>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--tp-muted)',
          
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  wide,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  wide?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={{ fontSize: 11, color: 'var(--tp-muted)' }}>
        {label}
        {required && <span style={{ color: 'var(--tp-danger)' }}> *</span>}
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--tp-subtle)', lineHeight: 1.35 }}>{hint}</span>
      )}
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--tp-surface-muted)',
  border: '1px solid var(--tp-border)',
  borderRadius: 6,
  color: 'var(--tp-text)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--tp-primary)',
  color: 'var(--tp-on-primary)',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
