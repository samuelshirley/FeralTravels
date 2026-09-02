import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ApiError,
  createVehicle,
  deleteVehicle,
  isAuthError,
  listVehicles,
  updateVehicle,
  type Vehicle,
} from "@/lib/api";
import { theme } from "@/lib/theme";
import { useUnits } from "@/lib/units";
import { kmToMi, miToKm, type UnitsPref } from "@/shared/lib/units";
import { font } from "@/lib/typography";
import {
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  validateVehicleProfileDraftForSave,
  vehicleProfileGroupTitle,
  type VehicleProfileFieldGroup,
  type VehicleProfileQuestion,
} from "@/shared/lib/vehicleProfile";

/**
 * Native mirror of src/components/VehicleProfileSection.tsx.
 *
 * Fields, labels, help text, bounds and validation all come out of
 * `@/shared/lib/vehicleProfile` — the same module the web form and the Penny
 * onboarding chat read — so adding a vehicle field stays a config-only change
 * on both platforms. Nothing about the field list is hardcoded here.
 *
 * The blurb above this section on both Settings pages used to advertise
 * "daily/weekly drive caps" and a "water refill / dump cadence" — fields
 * dropped in migrations 0014/0015. Fixed on both platforms 2026-09-02; the
 * form below has always reflected the CURRENT question set.
 *
 * Draft state stores canonical values (km for `*_km` fields, same as the API);
 * the mile display for imperial users is a pure view transform applied on the
 * way in and out of the text inputs.
 */

/** Draft carries the typed profile fields plus room for config-added keys. */
interface Draft extends Record<string, unknown> {
  name: string;
  range_km: number | null;
  is_default?: boolean;
}

function emptyDraft(): Draft {
  return {
    name: "",
    range_km: null,
  };
}

function draftFromVehicle(v: Vehicle): Draft {
  return {
    ...v,
    name: v.name,
    range_km: v.range_km,
    is_default: v.is_default,
  };
}

/**
 * The `_km` suffix is the schema's own marker for "stored metric": those are
 * the fields whose label, placeholder and min/max already arrive from
 * buildVehicleProfileQuestions() in the user's display unit, so their input
 * value has to be converted too. Keying off the suffix rather than a literal
 * field list keeps a newly configured distance field working for free.
 */
function isDistanceKey(key: string): boolean {
  return key.endsWith("_km");
}

/** Canonical draft value → the string the user should see, in display units. */
function toDisplayText(q: VehicleProfileQuestion, value: unknown, units: UnitsPref): string {
  if (value == null || value === "") return "";
  if (typeof value !== "number") return String(value);
  if (isDistanceKey(q.key) && units === "imperial") {
    const mi = kmToMi(value);
    return mi == null ? "" : String(Math.round(mi));
  }
  return String(value);
}

/** Run the shared coercion for one answer; returns its message, or null. */
function coerceError(q: VehicleProfileQuestion, displayRaw: unknown): string | null {
  try {
    coerceVehicleProfileValue(q, displayRaw);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid value.";
  }
}

export default function VehicleProfileSection() {
  const router = useRouter();
  const { units } = useUnits();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  // A 401 means the bearer token is dead; the global notifier stays silent on
  // 401 by design, so the screen has to route out of here itself.
  const handleAuthError = useCallback(
    (e: unknown): boolean => {
      if (!isAuthError(e)) return false;
      router.replace("/sign-in");
      return true;
    },
    [router]
  );

  const load = useCallback(async () => {
    try {
      const list = await listVehicles();
      setVehicles(list);
    } catch (e) {
      if (handleAuthError(e)) return;
      setError(e instanceof ApiError ? e.message : "Failed to load vehicles.");
    }
  }, [handleAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(draft: Draft, id: string | "new") {
    setSaving(true);
    setError(null);
    try {
      // Spreading the draft (rather than listing three keys) means a field
      // added to the shared question list reaches the validator untouched.
      const validated = validateVehicleProfileDraftForSave(
        {
          ...draft,
          name: draft.name ?? "",
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
      if (id === "new") {
        await createVehicle(payload);
      } else {
        await updateVehicle(id, payload);
      }
      setEditingId(null);
      await load();
    } catch (e) {
      if (handleAuthError(e)) return;
      setError(e instanceof ApiError ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(id: string) {
    // Native equivalent of the web's window.confirm('Delete this vehicle?').
    Alert.alert("Delete this vehicle?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void handleDelete(id);
        },
      },
    ]);
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteVehicle(id);
      await load();
    } catch (e) {
      if (handleAuthError(e)) return;
      setError(e instanceof ApiError ? e.message : "Delete failed.");
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await updateVehicle(id, { is_default: true });
      await load();
    } catch (e) {
      if (handleAuthError(e)) return;
      setError(e instanceof ApiError ? e.message : "Failed to set default.");
    }
  }

  return (
    <View>
      {error ? (
        // Inline, like the web. The global error surface also fires for API
        // failures because lib/api's vehicle helpers don't expose
        // skipGlobalErrorReport; only the local copy is guaranteed to match
        // the web's placement.
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        </View>
      ) : null}

      {vehicles == null ? (
        <Text style={styles.loading}>Loading vehicles…</Text>
      ) : (
        <>
          {vehicles.length === 1 ? (
            // Neutral hint, NOT an error: it explains why Delete is hidden on
            // a sole vehicle. Red danger styling here read as "the app thinks
            // I have no vehicle" to a real user, so it belongs only on the
            // delete-rejection error from the API.
            <View style={styles.soloHint}>
              <Text style={styles.soloHintText}>
                This is your only vehicle, so it can&apos;t be deleted. Add another vehicle
                first if you want to replace it.
              </Text>
            </View>
          ) : null}

          <View style={styles.cardList}>
            {vehicles.map((v) =>
              editingId === v.id ? (
                <VehicleForm
                  key={v.id}
                  initial={draftFromVehicle(v)}
                  saving={saving}
                  onSave={(d) => {
                    void handleSave(d, v.id);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <VehicleCard
                  key={v.id}
                  vehicle={v}
                  canDelete={vehicles.length > 1}
                  onEdit={() => setEditingId(v.id)}
                  onDelete={() => confirmDelete(v.id)}
                  onSetDefault={() => {
                    void handleSetDefault(v.id);
                  }}
                />
              )
            )}
          </View>

          {editingId === "new" ? (
            <View style={styles.newFormWrap}>
              <VehicleForm
                initial={emptyDraft()}
                saving={saving}
                onSave={(d) => {
                  void handleSave(d, "new");
                }}
                onCancel={() => setEditingId(null)}
              />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditingId("new")}
              style={styles.addButton}
            >
              <Text style={styles.addButtonText}>+ Add vehicle</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
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
  // The card's own "~400 km" phrasing, not the shared Distance component: this
  // is a soft planning number and the web prints the tilde inline.
  const fmtRange = (km: number | null): string | null => {
    if (km == null) return null;
    if (units === "imperial") {
      const mi = kmToMi(km);
      return mi == null ? null : `~${Math.round(mi)} mi`;
    }
    return `~${km} km`;
  };
  const refillLabel = fmtRange(vehicle.range_km);

  return (
    <View style={styles.vehicleCard}>
      <View style={styles.vehicleCardHead}>
        <View style={styles.vehicleNameRow}>
          <Text style={styles.vehicleName}>{vehicle.name}</Text>
          {vehicle.is_default ? (
            <View style={styles.defaultBadge}>
              <Text style={styles.defaultBadgeText}>DEFAULT</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actionRow}>
          {!vehicle.is_default ? (
            <SmallButton label="Set default" accent={theme.success} onPress={onSetDefault} />
          ) : null}
          <SmallButton label="Edit" accent={theme.primary} onPress={onEdit} />
          {canDelete ? (
            <SmallButton label="Delete" accent={theme.danger} onPress={onDelete} />
          ) : null}
        </View>
      </View>
      <View style={styles.statRow}>
        {refillLabel ? <Stat label="REFILL EVERY" value={refillLabel} /> : null}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Text style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text> </Text>
      <Text style={styles.statValue}>{value}</Text>
    </Text>
  );
}

function SmallButton({
  label,
  accent,
  onPress,
}: {
  label: string;
  accent: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.smallButton}>
      <Text style={[styles.smallButtonText, { color: accent }]}>{label}</Text>
    </Pressable>
  );
}

/** Seed one text-input string per numeric question from the canonical draft. */
function seedTexts(
  questions: VehicleProfileQuestion[],
  draft: Draft,
  units: UnitsPref
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    if (q.kind !== "number" && q.kind !== "integer") continue;
    out[q.key] = toDisplayText(q, draft[q.key], units);
  }
  return out;
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
  const { units } = useUnits();
  const questions = useMemo(() => buildVehicleProfileQuestions(units), [units]);
  const [d, setD] = useState<Draft>(() => ({ ...initial }));
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    seedTexts(buildVehicleProfileQuestions(units), initial, units)
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  // Flipping the units pref while this form is open must re-render the numbers
  // in the new unit. Re-seeding only on `units` (not on every draft keystroke)
  // is deliberate — depending on `d` would fight the user's typing.
  useEffect(() => {
    setTexts(seedTexts(buildVehicleProfileQuestions(units), d, units));
    setFieldErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  // Groups are discovered from the question list in declaration order, so a
  // new group in the config renders without touching this file.
  const groups = useMemo(() => {
    const seen: VehicleProfileFieldGroup[] = [];
    for (const q of questions) if (!seen.includes(q.group)) seen.push(q.group);
    return seen.map((group) => ({ group, items: questions.filter((q) => q.group === group) }));
  }, [questions]);

  function setFieldError(key: string, message: string | null) {
    setFieldErrors((p) => ({ ...p, [key]: message }));
  }

  function handleTextChange(q: VehicleProfileQuestion, raw: string) {
    setD((p) => ({ ...p, [q.key]: raw }));
    // Don't nag about a required field the user hasn't filled in yet — that
    // check belongs to the save-time validator.
    setFieldError(q.key, raw.trim() === "" ? null : coerceError(q, raw));
  }

  function handleNumberChange(q: VehicleProfileQuestion, raw: string) {
    setTexts((p) => ({ ...p, [q.key]: raw }));
    const trimmed = raw.trim();
    if (trimmed === "") {
      setD((p) => ({ ...p, [q.key]: null }));
      setFieldError(q.key, null);
      return;
    }
    // Coerce against the question the user is looking at: its min/max are
    // already expressed in the display unit, and so is `trimmed`.
    setFieldError(q.key, coerceError(q, trimmed));
    const n = Number(trimmed);
    // Same as the web: a half-typed or non-positive entry leaves the last good
    // canonical value alone rather than writing NaN into the draft.
    if (!Number.isFinite(n) || n <= 0) return;
    const canonical = isDistanceKey(q.key) && units === "imperial" ? miToKm(n) : n;
    setD((p) => ({
      ...p,
      [q.key]:
        canonical == null ? null : q.kind === "integer" ? Math.round(canonical) : canonical,
    }));
  }

  function handleSelectChange(q: VehicleProfileQuestion, value: string) {
    setD((p) => ({ ...p, [q.key]: value === "" ? null : value }));
    setFieldError(q.key, value === "" ? null : coerceError(q, value));
  }

  return (
    <View style={styles.form}>
      {groups.map(({ group, items }) => (
        <View key={group}>
          <Text style={styles.groupTitle}>
            {vehicleProfileGroupTitle(group).toUpperCase()}
          </Text>
          <View style={styles.groupBody}>
            {items.map((q) => (
              <Field
                key={q.key}
                label={q.label}
                required={!q.optional}
                hint={q.help}
                error={fieldErrors[q.key] ?? null}
              >
                {q.kind === "select" ? (
                  <SelectField
                    question={q}
                    value={typeof d[q.key] === "string" ? (d[q.key] as string) : ""}
                    onChange={(v) => handleSelectChange(q, v)}
                  />
                ) : q.kind === "text" ? (
                  <TextInput
                    value={typeof d[q.key] === "string" ? (d[q.key] as string) : ""}
                    onChangeText={(v) => handleTextChange(q, v)}
                    placeholder={q.placeholder}
                    placeholderTextColor={theme.subtle}
                    style={styles.input}
                    accessibilityLabel={q.label}
                  />
                ) : (
                  <TextInput
                    value={texts[q.key] ?? ""}
                    onChangeText={(v) => handleNumberChange(q, v)}
                    placeholder={q.placeholder}
                    placeholderTextColor={theme.subtle}
                    // 'integer' has no decimal separator to offer.
                    keyboardType={q.kind === "integer" ? "number-pad" : "decimal-pad"}
                    style={styles.input}
                    accessibilityLabel={q.label}
                  />
                )}
              </Field>
            ))}
          </View>
        </View>
      ))}

      {/* `is_default` is Settings-only, so it is intentionally absent from the
          shared question list and rendered by hand. */}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!d.is_default }}
        onPress={() => setD((p) => ({ ...p, is_default: !p.is_default }))}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, !!d.is_default && styles.checkboxOn]}>
          {d.is_default ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxLabel}>Use as my default vehicle</Text>
      </Pressable>

      <View style={styles.formActions}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancelButton}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onSave(d)}
          disabled={saving}
          style={[styles.saveButton, saving && styles.saveButtonBusy]}
        >
          <Text style={styles.saveButtonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * No native <select>: the options render as tappable rows so each option's
 * `description` stays visible, which the web crams into the option label.
 */
function SelectField({
  question,
  value,
  onChange,
}: {
  question: VehicleProfileQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = question.options ?? [];
  return (
    <View style={styles.optionList}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: value === "" }}
        onPress={() => onChange("")}
        style={[styles.option, value === "" && styles.optionSelected]}
      >
        <Text style={styles.optionLabel}>— Choose —</Text>
      </Pressable>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={[styles.option, selected && styles.optionSelected]}
          >
            <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
              {opt.label}
            </Text>
            {opt.description ? (
              <Text style={styles.optionDescription}>{opt.description}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {label}
        {required ? <Text style={styles.fieldRequired}> *</Text> : null}
      </Text>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      {children}
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  errorBox: {
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: theme.dangerMuted,
    borderWidth: 1,
    // src/components/VehicleProfileSection.tsx:129
    borderColor: "rgba(198, 93, 74, 0.35)",
  },
  errorText: { fontFamily: font.regular, color: theme.danger, fontSize: 12, lineHeight: 17 },
  loading: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  soloHint: {
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  soloHintText: { fontFamily: font.regular, color: theme.muted, fontSize: 12, lineHeight: 17 },
  cardList: { gap: 10 },
  newFormWrap: { marginTop: 12 },
  addButton: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: theme.primaryMuted,
    borderWidth: 1,
    borderStyle: "dashed",
    // src/components/VehicleProfileSection.tsx:207 — 1px dashed
    borderColor: "rgba(78, 122, 176, 0.45)",
    borderRadius: 8,
    alignItems: "center",
  },
  addButtonText: { color: theme.primary, fontFamily: font.semibold, fontSize: 13 },

  vehicleCard: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 14,
    backgroundColor: theme.surfaceMuted,
  },
  vehicleCardHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
  },
  vehicleNameRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  vehicleName: { fontSize: 15, fontFamily: font.bold, color: theme.text },
  defaultBadge: {
    backgroundColor: theme.successMuted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  defaultBadgeText: {
    fontSize: 9,
    fontFamily: font.bold,
    letterSpacing: 0.7,
    color: theme.success,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  smallButton: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
  },
  smallButtonText: { fontFamily: font.regular, fontSize: 11, letterSpacing: 0.4 },
  statRow: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 12 },
  stat: { fontFamily: font.regular, fontSize: 12 },
  statLabel: { color: theme.muted, letterSpacing: 0.7 },
  statValue: { color: theme.text, fontFamily: font.semibold },

  form: {
    borderWidth: 1,
    // src/components/VehicleProfileSection.tsx:422
    borderColor: "rgba(78, 122, 176, 0.35)",
    borderRadius: 10,
    padding: 14,
    backgroundColor: theme.primaryMuted,
    gap: 12,
  },
  groupTitle: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.2,
    color: theme.muted,
    marginBottom: 6,
  },
  groupBody: { gap: 10 },
  field: { gap: 4 },
  fieldLabel: { fontFamily: font.regular, fontSize: 11, color: theme.muted, lineHeight: 16 },
  fieldRequired: { color: theme.danger },
  fieldHint: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, lineHeight: 15 },
  fieldError: { fontFamily: font.regular, fontSize: 11, color: theme.danger, lineHeight: 15 },
  input: {
    fontFamily: font.regular,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    color: theme.text,
    fontSize: 13,
  },
  optionList: { gap: 6 },
  option: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
  },
  optionSelected: { borderColor: theme.primary, backgroundColor: theme.primaryMuted },
  optionLabel: { fontFamily: font.regular, fontSize: 13, color: theme.text },
  optionLabelSelected: { fontFamily: font.semibold, color: theme.primary },
  optionDescription: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, marginTop: 2, lineHeight: 15 },

  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  checkboxMark: { color: theme.onPrimary, fontSize: 12, fontFamily: font.bold, lineHeight: 14 },
  checkboxLabel: { fontFamily: font.regular, fontSize: 13, color: theme.muted },

  formActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  cancelButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  cancelButtonText: { fontSize: 13, fontFamily: font.semibold, color: theme.muted },
  saveButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
    backgroundColor: theme.primary,
  },
  saveButtonBusy: { opacity: 0.6 },
  saveButtonText: { fontSize: 13, fontFamily: font.semibold, color: theme.onPrimary },
});
