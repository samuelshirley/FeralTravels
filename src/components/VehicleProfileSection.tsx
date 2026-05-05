'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { kmToMi, miToKm } from '@/lib/units';
import { useUnits } from '@/components/UnitsContext';

/**
 * Vehicle profile — the simplified shape introduced by migration 0007.
 *
 * Old fields that no longer exist (vehicle_type, dimensions, fuel_type,
 * fuel_economy_kmpl, fuel_tank_l, real_world_kmpl, fuel_timing_pref, water
 * capacities, notes) have been collapsed into `refill_distance_km` plus the
 * drive-limit + water-cadence fields. The UI lets the user enter the refill
 * distance in their preferred units (km or mi); the DB always stores km.
 */
export interface Vehicle {
  id: number;
  user_id: string;
  name: string;
  is_default: boolean;
  refill_distance_km: number | null;
  max_drive_hours_per_day: number | null;
  max_drive_hours_per_week: number | null;
  max_consecutive_drive_days: number | null;
  water_refill_days: number | null;
  blackwater_refill_days: number | null;
  created_at: string;
  updated_at: string;
}

type Draft = Partial<Vehicle> & { name: string };

function emptyDraft(): Draft {
  return {
    name: '',
    refill_distance_km: null,
    max_drive_hours_per_day: null,
    max_drive_hours_per_week: null,
    max_consecutive_drive_days: null,
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
  const { units } = useUnits();
  const refillLabel = (() => {
    if (vehicle.refill_distance_km == null) return null;
    if (units === 'imperial') {
      const mi = kmToMi(vehicle.refill_distance_km);
      return mi == null ? null : `~${Math.round(mi)} mi`;
    }
    return `~${vehicle.refill_distance_km} km`;
  })();

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
        {refillLabel && <Stat label="Refill every" value={refillLabel} />}
        {vehicle.max_drive_hours_per_day != null && (
          <Stat label="Drive/day" value={`${vehicle.max_drive_hours_per_day}h`} />
        )}
        {vehicle.max_drive_hours_per_week != null && (
          <Stat label="Drive/week" value={`${vehicle.max_drive_hours_per_week}h`} />
        )}
        {vehicle.max_consecutive_drive_days != null && (
          <Stat label="Consec. days" value={`${vehicle.max_consecutive_drive_days}`} />
        )}
        {vehicle.water_refill_days != null && (
          <Stat label="Water refill" value={`every ${vehicle.water_refill_days}d`} />
        )}
        {vehicle.blackwater_refill_days != null && (
          <Stat label="Water dump" value={`every ${vehicle.blackwater_refill_days}d`} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: 'var(--tp-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>{' '}
      <span style={{ color: 'var(--tp-text)', fontWeight: 600 }}>{value}</span>
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

/**
 * The form has three groups: Identity (just name), Driving limits, Water.
 * Refill distance lives in its own labeled field at the top of Driving.
 *
 * Refill distance is the only field that's unit-aware on input. We store km
 * in the draft state regardless of which unit the user typed: the input
 * displays converted miles when imperial is active, and converts back to km
 * (rounded to whole km) on every keystroke. That keeps the rest of the form
 * — and the API payload — in one consistent unit.
 */
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
  const { units } = useUnits();
  const isImperial = units === 'imperial';

  function num(field: keyof Draft) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.trim();
      setD((p) => ({ ...p, [field]: v === '' ? null : Number(v) }));
    };
  }

  // Refill distance input — display in current unit, store as km.
  const refillDisplay = (() => {
    if (d.refill_distance_km == null) return '';
    if (!isImperial) return String(d.refill_distance_km);
    const mi = kmToMi(d.refill_distance_km);
    return mi == null ? '' : String(Math.round(mi));
  })();

  function handleRefillChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.trim();
    if (raw === '') {
      setD((p) => ({ ...p, refill_distance_km: null }));
      return;
    }
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) return;
    const km = isImperial ? miToKm(val) : val;
    setD((p) => ({
      ...p,
      refill_distance_km: km == null ? null : Math.round(km),
    }));
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
        <Field label="Name" required wide>
          <input
            value={d.name}
            onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))}
            style={inputStyle}
            placeholder="e.g. The Hilux"
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Driving limits">
        <Field
          label={`Refill every (${isImperial ? 'mi' : 'km'})`}
          hint="How far you like to drive between fuel stops. Penny plans a refuel around this distance."
          wide
        >
          <input
            type="number"
            step="1"
            min="1"
            value={refillDisplay}
            onChange={handleRefillChange}
            placeholder={isImperial ? '250' : '400'}
            style={inputStyle}
          />
        </Field>
        <Field label="Hours / day">
          <input
            type="number"
            step="0.5"
            value={d.max_drive_hours_per_day ?? ''}
            onChange={num('max_drive_hours_per_day')}
            style={inputStyle}
          />
        </Field>
        <Field label="Hours / week">
          <input
            type="number"
            step="0.5"
            value={d.max_drive_hours_per_week ?? ''}
            onChange={num('max_drive_hours_per_week')}
            style={inputStyle}
          />
        </Field>
        <Field label="Consec. days">
          <input
            type="number"
            value={d.max_consecutive_drive_days ?? ''}
            onChange={num('max_consecutive_drive_days')}
            style={inputStyle}
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Water">
        <Field label="Refill (days)" hint="Days between freshwater top-ups.">
          <input
            type="number"
            value={d.water_refill_days ?? ''}
            onChange={num('water_refill_days')}
            style={inputStyle}
          />
        </Field>
        <Field label="Dump (days)" hint="Days between black/grey water dumps.">
          <input
            type="number"
            value={d.blackwater_refill_days ?? ''}
            onChange={num('blackwater_refill_days')}
            style={inputStyle}
          />
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
