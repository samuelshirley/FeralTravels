import { API_BASE_URL } from "@/lib/config";
import { getToken, clearToken } from "@/lib/auth";
import type {
  Trip,
  TripWithLegs,
  LegWithDetails,
  ChatMessage,
  OnboardingState,
  POI,
  Stop,
  GPXTrail,
} from "@/shared/types/trip";

/**
 * Native mirror of src/lib/api.ts.
 *
 * Same method names, same paths, same error shape — the ONLY differences are
 * transport-level: an absolute base URL instead of same-origin, and an
 * `Authorization: Bearer <token>` header instead of a cookie. Keeping the
 * surface identical is deliberate: when the web client gains a call, the
 * mobile one gets the same name so the two can't drift semantically.
 */

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Opt out of the global error surface when rendering inline error UI. */
  skipGlobalErrorReport?: boolean;
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  errorId: string | null;
  constructor(status: number, message: string, payload: unknown, errorId?: string) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.errorId = errorId ?? null;
  }
}

/** True when the server rejected our session (signed out / expired). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

type GlobalErrorReporter = (
  err: unknown,
  context: { path: string; status: number | null; errorId?: string }
) => void;
let globalErrorReporter: GlobalErrorReporter | null = null;

export function registerGlobalErrorReporter(fn: GlobalErrorReporter | null): void {
  globalErrorReporter = fn;
}

function buildUrl(path: string, query?: ApiOptions["query"]): string {
  let qs = "";
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    qs = parts.join("&");
  }
  return `${API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const isFormData =
    typeof FormData !== "undefined" && opts.body instanceof FormData;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(await authHeaders()),
        ...(opts.headers || {}),
      },
      body:
        opts.body == null
          ? undefined
          : isFormData
            ? (opts.body as FormData)
            : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    // fetch threw = the request never reached a server (DNS, refused, offline).
    // Surface WHERE we tried to go — "check your connection" alone hides the
    // most common dev mistake (wrong/unset EXPO_PUBLIC_API_URL).
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[api] network failure for ${url}: ${detail}`);
    const wrapped = new ApiError(0, `Could not reach ${API_BASE_URL} (${detail})`, null);
    if (!opts.skipGlobalErrorReport && globalErrorReporter) {
      globalErrorReporter(wrapped, { path, status: null });
    }
    throw wrapped;
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const message =
      (rec && typeof rec.error === "string" ? rec.error : null) ||
      `HTTP ${res.status}`;
    const errorId = rec && typeof rec.errorId === "string" ? rec.errorId : undefined;
    const err = new ApiError(res.status, message, data, errorId);
    // 401 = the session row is gone or expired. Drop the keychain copy so the
    // gate sends the user to sign-in instead of looping on a dead token.
    if (res.status === 401) await clearToken();
    if (!opts.skipGlobalErrorReport && globalErrorReporter) {
      globalErrorReporter(err, { path, status: res.status, errorId });
    }
    throw err;
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function requestOtp(email: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/mobile/otp/send", { body: { email }, skipGlobalErrorReport: true });
}

export interface SessionResult {
  token: string;
  expires: string;
  user: { id: string; email: string };
}

export function verifyOtp(email: string, code: string): Promise<SessionResult> {
  return apiFetch("/api/mobile/otp/verify", {
    body: { email, code },
    skipGlobalErrorReport: true,
  });
}

/**
 * Exchange a native OAuth result for a session token. Mirrors the web's
 * `signIn('google')` / Auth.js Apple provider, but returns the token in the
 * body the way /api/mobile/otp/verify does. See src/app/api/mobile/oauth/.
 */
export function exchangeOAuth(payload: {
  provider: "google" | "apple";
  idToken: string;
  /** Apple only: the display name, which Apple sends exactly once. */
  fullName?: string | null;
}): Promise<SessionResult> {
  return apiFetch("/api/mobile/oauth/exchange", {
    body: payload,
    skipGlobalErrorReport: true,
  });
}

// ---------------------------------------------------------------------------
// Me / preferences
// ---------------------------------------------------------------------------

/**
 * GET /api/me is deliberately PII-free — it returns ONLY units_pref and
 * timezone. There is no name/email here to render in the account menu; the web
 * gets those from the server session, which the app has no equivalent of. The
 * email the user signed in with is kept locally at sign-in instead.
 */
export interface Me {
  units_pref?: string | null;
  timezone?: string | null;
}

export const getMe = () => apiFetch<Me>("/api/me");

/**
 * The signed-in user's own identity — the account button's data.
 *
 * A SECOND route rather than fields on `Me` on purpose: `/api/me` is fetched
 * on app start for units + timezone and is deliberately PII-free, so identity
 * gets its own narrow read. `image` is the Google profile photo, already
 * host-allowlisted server-side; it is null for Apple (whose ID token carries
 * no picture claim, ever) and for emailed-code sign-ins.
 */
export interface Identity {
  email: string | null;
  name: string | null;
  image: string | null;
}

export const getIdentity = () => apiFetch<Identity>("/api/me/identity");

export const updatePreferences = (body: { units_pref?: string; timezone?: string }) =>
  apiFetch("/api/me/preferences", { method: "PATCH", body });

/**
 * Permanently delete the signed-in account. Same route the web calls — the
 * server resolves our bearer token against the same sessions table a cookie
 * would hit, so there is one deletion implementation, not a native copy of one.
 *
 * `confirm` must be the phrase from shared/lib/accountDeletion; the server
 * re-checks it, so a UI bug cannot delete an account on its own.
 *
 * Opted out of the global notifier: the confirm dialog shows the failure inline,
 * and a toast over a modal the user is already reading is just noise.
 */
export const deleteAccount = (confirm: string): Promise<{ ok: boolean }> =>
  apiFetch("/api/me/delete", { method: "POST", body: { confirm }, skipGlobalErrorReport: true });

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export const listTrips = () => apiFetch<Trip[]>("/api/trips");
export const createTrip = () => apiFetch<Trip>("/api/trips", { body: {} });
export const cloneTrip = (tripId: string) =>
  apiFetch<{ id: string }>(`/api/trips/${tripId}/clone`, { body: {} });
export const deleteTrip = (tripId: string) =>
  apiFetch(`/api/trips/${tripId}`, { method: "DELETE" });
export const updateTrip = (tripId: string, body: Record<string, unknown>) =>
  apiFetch<Trip>(`/api/trips/${tripId}`, { method: "PATCH", body });
export const reportPosition = (
  tripId: string,
  body: { lat: number; lng: number; place_name?: string | null }
) => apiFetch(`/api/trips/${tripId}/position`, { body });

/**
 * GET /api/trip returns `getTripFull()` — a FLAT trip row with `legs` nested
 * inside it (TripWithLegs), NOT a { trip, legs } envelope. Getting this wrong
 * made every trip render "Trip not found", because `payload.trip` was
 * undefined. The web guards with `'legs' in tripData` for the same reason.
 */

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export interface Vehicle extends Record<string, unknown> {
  id: string;
  name: string;
  is_default: boolean;
  range_km: number | null;
}

export const listVehicles = () => apiFetch<Vehicle[]>("/api/vehicles");
export const createVehicle = (body: Record<string, unknown>) =>
  apiFetch<Vehicle>("/api/vehicles", { body });
export const updateVehicle = (id: string, body: Record<string, unknown>) =>
  apiFetch<Vehicle>(`/api/vehicles/${id}`, { method: "PATCH", body });
export const deleteVehicle = (id: string) =>
  apiFetch(`/api/vehicles/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Announcements / support
// ---------------------------------------------------------------------------

export interface Announcement {
  id: string;
  title: string;
  body: string;
}
export const activeAnnouncement = async (): Promise<Announcement | null> => {
  // The route wraps it: { announcement }. Reading it bare gave a truthy object
  // that was never a real announcement.
  const res = await apiFetch<{ announcement: Announcement | null }>(
    "/api/announcements/active",
    { skipGlobalErrorReport: true }
  );
  return res?.announcement ?? null;
};
export const dismissAnnouncement = (announcementId: string) =>
  apiFetch("/api/announcements/dismiss", { body: { announcementId } });
export const sendSupport = (message: string) => apiFetch("/api/support", { body: { message } });

// ---------------------------------------------------------------------------
// Trip-scoped helpers — mirrors tripApi() in src/lib/api.ts
// ---------------------------------------------------------------------------

export function tripApi(tripId: string) {
  return {
    getTrip: () => apiFetch<TripWithLegs>("/api/trip", { query: { tripId } }),

    listPois: () => apiFetch<POI[]>("/api/pois", { query: { tripId } }),

    planFuelStops: (legId: string) =>
      apiFetch<{
        legId: string;
        status: "ready" | "failed" | "skipped";
        stopsCreated?: number;
        reason?: string;
      }>(`/api/legs/${legId}/fuel-stops`, { method: "POST", body: {} }),

    listStopsForLeg: (legId: string) =>
      apiFetch<Stop[]>("/api/stops", { query: { tripId, legId } }),
    addStop: (legId: string, payload: Record<string, unknown>) =>
      apiFetch<Stop>("/api/stops", { body: { tripId, leg_id: legId, ...payload } }),
    updateStop: (
      stopId: string,
      data: Record<string, unknown>,
      opts?: Pick<ApiOptions, "skipGlobalErrorReport">
    ) => apiFetch(`/api/stops/${stopId}`, { method: "PATCH", body: { tripId, ...data }, ...opts }),
    deleteStop: (stopId: string, opts?: Pick<ApiOptions, "skipGlobalErrorReport">) =>
      apiFetch(`/api/stops/${stopId}`, { method: "DELETE", query: { tripId }, ...opts }),
    selectStop: (stopId: string, opts?: Pick<ApiOptions, "skipGlobalErrorReport">) =>
      apiFetch(`/api/stops/${stopId}/select`, { method: "POST", body: {}, ...opts }),
    swapStopPrimary: (
      stopId: string,
      altIndex: number,
      opts?: Pick<ApiOptions, "skipGlobalErrorReport">
    ) =>
      apiFetch(`/api/stops/${stopId}/swap-primary`, {
        method: "POST",
        body: { alt_index: altIndex },
        ...opts,
      }),

    parseCoords: (input: string) =>
      apiFetch<{
        lat: number;
        lng: number;
        name?: string;
        source?: string;
        source_url?: string;
      }>("/api/coords/parse", { body: { input }, skipGlobalErrorReport: true }),

    listGpxForLeg: (legId: string) =>
      apiFetch<GPXTrail[]>("/api/gpx", { query: { tripId, legId } }),

    // ---- chat / onboarding ----
    listChat: (before?: number) =>
      apiFetch<{ messages: ChatMessage[]; hasMore: boolean }>("/api/chat", {
        query: { tripId, before },
      }),
    getOnboarding: () => apiFetch<OnboardingSnapshot>(`/api/trips/${tripId}/onboarding`),
    answerOnboarding: (questionKey: string, value: string | number | null) =>
      apiFetch<OnboardingAnswer>(`/api/trips/${tripId}/onboarding`, {
        body: { questionKey, value },
      }),
    /** Poll a turn by idempotency key to heal a dropped chat stream. */
    getTurn: (idempotencyKey: string) =>
      apiFetch<{ turn: TurnRecord | null }>(`/api/trips/${tripId}/turns`, {
        query: { idempotencyKey },
        skipGlobalErrorReport: true,
      }),
  };
}

// ---------------------------------------------------------------------------
// Onboarding / chat contracts (mirrors the route handlers' response shapes)
// ---------------------------------------------------------------------------

/**
 * Wire shape of one onboarding question.
 *
 * Field-for-field copy of `Question` in src/server/onboarding.ts — the server
 * serializes that object verbatim (GET and POST both hand back the snapshot
 * built by `getOnboardingSnapshot`; see
 * src/app/api/trips/[id]/onboarding/route.ts). The web client mirrors the same
 * shape as `OnboardingFormQuestion` in src/components/ChatPanel.tsx.
 * Re-verify against those two files before changing anything here.
 */
export interface OnboardingQuestion {
  key: string;
  kind: "text" | "number" | "integer" | "select" | "handoff";
  label: string;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  optional?: boolean;
  min?: number;
  max?: number;
  /** UI hint: render a multiline textarea instead of an input. */
  multiline?: boolean;
  /** Prefilled answer (e.g. a start date extracted from the trip description). */
  defaultValue?: string;
}

/**
 * GET /api/trips/:id/onboarding — copy of `OnboardingSnapshot` in
 * src/server/onboarding.ts.
 */
export interface OnboardingSnapshot {
  state: OnboardingState;
  /** Next question to ask, or null if onboarding is done. */
  question: OnboardingQuestion | null;
  /** @deprecated Legacy field — vehicle_pick no longer part of onboarding. Always empty. */
  vehicles: Array<{ id: string; name: string; is_default: boolean }>;
  /** Progress counter — "3 of 8" style. */
  progress: { current: number; total: number } | null;
}

/**
 * POST /api/trips/:id/onboarding — copy of `SubmitAnswerResult` in
 * src/server/onboarding.ts. Note `next` is a full snapshot, not a question.
 */
export interface OnboardingAnswer {
  next: OnboardingSnapshot;
  answerLabel: string;
  didHandoff: boolean;
  /** The stored trip intent to send to Penny when onboarding is done. */
  tripIntent?: string;
  /**
   * Deterministic one-line acknowledgment for the client to render as a Penny
   * bubble (e.g. the trip_date step confirming the date, or telling the user a
   * placeholder was used). Composed by the form, NOT the LLM.
   */
  note?: string;
}

export interface TurnRecord {
  status: "queued" | "running" | "done" | "error";
  assistantMessage?: ChatMessage | null;
  error?: string | null;
}
