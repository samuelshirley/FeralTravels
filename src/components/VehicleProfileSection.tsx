'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { fetchVehicles, invalidateVehicleCache } from '@/lib/vehicleCache';
import { kmToMi, miToKm } from '@/lib/units';
import { useUnits } from '@/components/UnitsContext';
import {
  buildVehicleProfileQuestions,
  validateVehicleProfileDraftForSave,
  vehicleProfileGroupTitle,
  type VehicleProfileFieldKey,
} from '@/lib/vehicleProfile';

const PROFILE_FIELD_TEST_IDS: Partial<Record<VehicleProfileFieldKey, string>> = {};

/**
 * Vehicle profile row shape — refill cadence + drive/water limits (`vehicles` table).
 * Distances are stored in km; UI converts via units preference.
 */
export interface Vehicle {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  range_km: number | null;
  created_at: string;
  updated_at: string;
}

type Draft = Partial<Vehicle> & { name: string };

function emptyDraft(): Draft {
  return {
    name: '',
    range_km: null,
  };
}

export default function VehicleProfileSection() {
  const { units } = useUnits();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const list = await fetchVehicles();
      setVehicles(list);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load vehicles.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave(draft: Draft, id: string | 'new') {
    setSaving(true);
    setError(null);
    try {
      const validated = validateVehicleProfileDraftForSave(
        {
          name: draft.name ?? '',
          range_km: draft.range_km ?? null,
          is_default: draft.is_default,
        },
        units
      );
      if (!validated.ok) {
        setError(validated.error);
        return;
      }
      const payload = validated.payload;
      if (id === 'new') {
        await apiFetch('/api/vehicles', { body: payload });
      } else {
        await apiFetch(`/api/vehicles/${id}`, { method: 'PATCH', body: payload });
      }
      invalidateVehicleCache();
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this vehicle?')) return;
    setError(null);
    try {
      await apiFetch(`/api/vehicles/${id}`, { method: 'DELETE' });
      invalidateVehicleCache();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await apiFetch(`/api/vehicles/${id}`, {
        method: 'PATCH',
        body: { is_default: true },
      });
      invalidateVehicleCache();
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
          {vehicles.length === 1 && (
            // Neutral hint, NOT an error: it explains why Delete is hidden on
            // a sole vehicle. This used to render as a red danger banner
            // saying "You need at least one vehicle." — which a user with one
            // vehicle read as "the app thinks I have no vehicle" (real user
            // confusion, 2026-07-02). The danger styling belongs only on the
            // delete-rejection error from the API, not on this standing note.
            <div
              data-testid="vehicle-solo-reminder"
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--tp-surface)',
                border: '1px solid var(--tp-border)',
                color: 'var(--tp-muted)',
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              This is your only vehicle, so it can&apos;t be deleted. Add another
              vehicle first if you want to replace it.
            </div>
          )}
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
                    canDelete={vehicles.length > 1}
                    onEdit={() => setEditingId(v.id)}
                    onDelete={() => handleDelete(v.id)}
                    onSetDefault={() => handleSetDefault(v.id)}
                  />
                )}
              </div>
            ))}
          </div>

          {editingId === 'new' ? (
            <div style={{ marginTop: 12 }} data-testid="vehicle-form">
              <VehicleForm
                initial={emptyDraft()}
                saving={saving}
                onSave={(d) => handleSave(d, 'new')}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <button
              data-testid="add-vehicle-button"
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

function VehicleCard({
  vehicle,
  canDelete,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  vehicle: Vehicle;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const { units } = useUnits();
  const fmtRange = (km: number | null): string | null => {
    if (km == null) return null;
    if (units === 'imperial') {
      const mi = kmToMi(km);
      return mi == null ? null : `~${Math.round(mi)} mi`;
    }
    return `~${km} km`;
  };
  const refillLabel = fmtRange(vehicle.range_km);

  return (
    <div
      data-testid="vehicle-card"
      data-vehicle-name={vehicle.name}
      style={{
        border: '1px solid var(--tp-border)',
        borderRadius: 10,
        padding: 14,
        background: 'var(--tp-surface-muted)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15 }} data-testid="vehicle-card-name">{vehicle.name}</strong>
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
          {canDelete && (
            <button
              data-testid="vehicle-delete-button"
              onClick={onDelete}
              style={smallBtnStyle('var(--tp-danger)')}
            >
              Delete
            </button>
          )}
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
 * Fields, labels, and validation are driven by `@/lib/vehicleProfile` so this
 * stays aligned with onboarding chat. Refill distance is unit-aware on input;
 * draft state stores km, same as the API.
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
  const [d, setD] = useState<Draft>(() => ({ ...initial }));
  const { units } = useUnits();
  const isImperial = units === 'imperial';
  const questions = buildVehicleProfileQuestions(units);
  const groups = (['identity', 'driving'] as const).map((g) => ({
    group: g,
    items: questions.filter((q) => q.group === g),
  }));

  function num(field: VehicleProfileFieldKey) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.trim();
      setD((p) => ({ ...p, [field]: v === '' ? null : Number(v) }));
    };
  }

  const refillDisplay = (() => {
    if (d.range_km == null) return '';
    if (!isImperial) return String(d.range_km);
    const mi = kmToMi(d.range_km);
    return mi == null ? '' : String(Math.round(mi));
  })();

  function handleRefillChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.trim();
    if (raw === '') {
      setD((p) => ({ ...p, range_km: null }));
      return;
    }
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) return;
    const km = isImperial ? miToKm(val) : val;
    setD((p) => ({
      ...p,
      range_km: km == null ? null : Math.round(km),
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
      {groups.map(({ group, items }) => (
        <FieldGroup key={group} title={vehicleProfileGroupTitle(group)}>
          {items.map((q) => {
            if (q.key === 'name') {
              return (
                <Field key={q.key} label={q.label} required={!q.optional} wide hint={q.help}>
                  <input
                    data-testid="vehicle-name-input"
                    value={d.name}
                    onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))}
                    style={inputStyle}
                    placeholder={q.placeholder}
                  />
                </Field>
              );
            }
            if (q.key === 'range_km') {
              return (
                <Field key={q.key} label={q.label} required={!q.optional} wide hint={q.help}>
                  <input
                    data-testid="vehicle-refill-input"
                    type="number"
                    step="1"
                    min={q.min}
                    max={q.max}
                    value={refillDisplay}
                    onChange={handleRefillChange}
                    placeholder={q.placeholder}
                    style={inputStyle}
                  />
                </Field>
              );
            }
            if (q.kind === 'select' && q.options) {
              return (
                <Field key={q.key} label={q.label} required={!q.optional} wide hint={q.help}>
                  <select
                    data-testid={PROFILE_FIELD_TEST_IDS[q.key]}
                    value={(d as Record<string, unknown>)[q.key] as string ?? ''}
                    onChange={(e) => setD((p) => ({ ...p, [q.key]: e.target.value || null }))}
                    style={inputStyle}
                  >
                    <option value="">— Choose —</option>
                    {q.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}{opt.description ? ` — ${opt.description}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            }
            const step = q.kind === 'integer' ? '1' : '0.5';
            const val = d[q.key];
            return (
              <Field key={q.key} label={q.label} required={!q.optional} hint={q.help}>
                <input
                  type="number"
                  data-testid={PROFILE_FIELD_TEST_IDS[q.key]}
                  step={step}
                  min={q.min}
                  max={q.max}
                  value={val ?? ''}
                  onChange={num(q.key)}
                  placeholder={q.placeholder}
                  style={inputStyle}
                />
              </Field>
            );
            })}
        </FieldGroup>
      ))}

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
        <button
          data-testid="vehicle-save-button"
          onClick={() => onSave(d)}
          disabled={saving}
          style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}
        >
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
