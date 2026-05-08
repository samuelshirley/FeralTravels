'use client';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Opt a specific call out of the global ErrorNotifier toast/modal.
   * Use for components that render their own inline error UI and don't
   * want a double-notification.
   */
  skipGlobalErrorReport?: boolean;
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

// --- Global error reporter hook ---------------------------------------------
// The ErrorNotifier component (rendered once in the root layout) registers a
// callback here on mount. apiFetch invokes it after every failed request so
// toast / modal surfaces fire without every caller having to wire them up.
//
// Kept as a module-level binding rather than a React context so non-component
// code (e.g. Spinner fallbacks, service-worker messages) can trigger it too.
type GlobalErrorReporter = (err: unknown, context: { path: string; status: number | null }) => void;
let globalErrorReporter: GlobalErrorReporter | null = null;

export function registerGlobalErrorReporter(fn: GlobalErrorReporter | null): void {
  globalErrorReporter = fn;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiFetch<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const isFormData = opts.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(opts.headers || {}),
      },
      body: opts.body == null
        ? undefined
        : isFormData
          ? (opts.body as FormData)
          : JSON.stringify(opts.body),
      signal: opts.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    // Network failure (offline, DNS, certificate, aborted by user). Treat
    // as a 5xx-equivalent so ErrorNotifier surfaces the silly modal.
    if (!opts.skipGlobalErrorReport && globalErrorReporter) {
      globalErrorReporter(err, { path, status: null });
    }
    throw err;
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
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof (data as any).error === 'string'
        ? (data as any).error
        : null) || res.statusText || `HTTP ${res.status}`;
    const err = new ApiError(res.status, message, data);
    if (!opts.skipGlobalErrorReport && globalErrorReporter) {
      globalErrorReporter(err, { path, status: res.status });
    }
    throw err;
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Trip-scoped helpers — pass tripId once, reuse everywhere.
// ---------------------------------------------------------------------------

export function tripApi(tripId: number) {
  return {
    getTrip: () => apiFetch(`/api/trip`, { query: { tripId } }),
    replan: (message: string, images: Array<{ dataUrl: string; mediaType: string }> = []) =>
      apiFetch(`/api/trip/replan`, { body: { tripId, message, images } }),

    listRoutes: (legId: number) => apiFetch(`/api/routes`, { query: { tripId, legId } }),
    addRoute: (legId: number, payload: Record<string, unknown>) =>
      apiFetch(`/api/routes`, { body: { tripId, leg_id: legId, ...payload } }),
    updateRoute: (routeId: number, data: Record<string, unknown>) =>
      apiFetch(`/api/routes/${routeId}`, { method: 'PATCH', body: { tripId, ...data } }),
    deleteRoute: (routeId: number) =>
      apiFetch(`/api/routes/${routeId}`, { method: 'DELETE', query: { tripId } }),
    selectRoute: (routeId: number) =>
      apiFetch(`/api/routes/${routeId}/select`, { method: 'POST', body: {} }),
    addRouteLink: (routeId: number, payload: Record<string, unknown>) =>
      apiFetch(`/api/routes/${routeId}/links`, { body: { tripId, ...payload } }),
    deleteRouteLink: (routeId: number, linkId: number) =>
      apiFetch(`/api/routes/${routeId}/links`, {
        method: 'DELETE',
        query: { tripId, linkId },
      }),

    /**
     * Kick off the server-side fuel stop planner for a leg. Returns
     * `{ status: 'ready'|'failed'|'skipped', stopsCreated?, reason? }`.
     * See src/server/fuel.ts for the algorithm.
     */
    planFuelStops: (legId: number) =>
      apiFetch<{
        legId: number;
        status: 'ready' | 'failed' | 'skipped';
        stopsCreated?: number;
        reason?: string;
      }>(`/api/legs/${legId}/fuel-stops`, { method: 'POST', body: {} }),

    /**
     * Recompute auto fuel stops for legs on this trip (in sort order).
     *
     * Pass `startFromSortOrder` to skip legs ahead of a known edit point —
     * cumulative tank-state math flows forward, so unchanged front legs don't
     * need re-planning. Omit for a full replan (e.g. on vehicle change).
     */
    replenishFuelStops: (opts?: { startFromSortOrder?: number }) =>
      apiFetch<{ ok: boolean }>(`/api/trips/${tripId}/fuel-stops/replan`, {
        method: 'POST',
        body:
          opts?.startFromSortOrder !== undefined
            ? { start_from_sort_order: opts.startFromSortOrder }
            : {},
      }),

    listStopsForLeg: (legId: number) => apiFetch(`/api/stops`, { query: { tripId, legId } }),
    addStop: (legId: number, payload: Record<string, unknown>) =>
      apiFetch(`/api/stops`, { body: { tripId, leg_id: legId, ...payload } }),
    /**
     * Mutating-stop calls (`updateStop`, `deleteStop`, `selectStop`) accept
     * `skipGlobalErrorReport` so callers can swallow 404s caused by an
     * auto-replan rewriting the row's id. The handlers in StopsSection use
     * this to silently re-fetch instead of showing the global error toast.
     */
    updateStop: (
      stopId: number,
      data: Record<string, unknown>,
      opts?: Pick<ApiOptions, 'skipGlobalErrorReport'>
    ) =>
      apiFetch(`/api/stops/${stopId}`, {
        method: 'PATCH',
        body: { tripId, ...data },
        ...opts,
      }),
    deleteStop: (stopId: number, opts?: Pick<ApiOptions, 'skipGlobalErrorReport'>) =>
      apiFetch(`/api/stops/${stopId}`, {
        method: 'DELETE',
        query: { tripId },
        ...opts,
      }),
    selectStop: (stopId: number, opts?: Pick<ApiOptions, 'skipGlobalErrorReport'>) =>
      apiFetch(`/api/stops/${stopId}/select`, {
        method: 'POST',
        body: {},
        ...opts,
      }),
    /**
     * Atomically swap a fuel/rest stop's primary fields with one of its
     * persisted alternates so the user can swap stations without a Places
     * round-trip. See /api/stops/:id/swap-primary.
     */
    swapStopPrimary: (
      stopId: number,
      altIndex: number,
      opts?: Pick<ApiOptions, 'skipGlobalErrorReport'>
    ) =>
      apiFetch(`/api/stops/${stopId}/swap-primary`, {
        method: 'POST',
        body: { alt_index: altIndex },
        ...opts,
      }),
    /** Parse GPS coordinates / URLs pasted by the user. See /api/coords/parse. */
    parseCoords: (input: string) =>
      apiFetch<{
        lat: number;
        lng: number;
        name?: string;
        source?: string;
        source_url?: string;
      }>(`/api/coords/parse`, { body: { input } }),

    /** Nearby dog parks / parks via Places API (server). Errors may return 200 + `error` or 503. */
    nearbyParks: (
      legId: number,
      coords: { lat: number; lng: number },
      opts?: Pick<ApiOptions, 'signal' | 'skipGlobalErrorReport'>
    ) =>
      apiFetch<{
        dogParks: Array<{
          name: string;
          lat: number;
          lng: number;
          placeId: string | null;
          primaryType: string | null;
          googleMapsUri: string | null;
          distanceKm: number;
          within5Km: boolean;
        }>;
        parks: Array<{
          name: string;
          lat: number;
          lng: number;
          placeId: string | null;
          primaryType: string | null;
          googleMapsUri: string | null;
          distanceKm: number;
          within5Km: boolean;
        }>;
        error?: string;
      }>(`/api/places/nearby-parks`, {
        query: { tripId, legId, lat: coords.lat, lng: coords.lng },
        ...opts,
      }),

    listTasksForLeg: (legId: number) => apiFetch(`/api/tasks`, { query: { tripId, legId } }),
    listTasksForTrip: () => apiFetch(`/api/tasks`, { query: { tripId } }),
    addTask: (payload: Record<string, unknown>) =>
      apiFetch(`/api/tasks`, { body: { tripId, ...payload } }),
    updateTask: (taskId: number, data: Record<string, unknown>) =>
      apiFetch(`/api/tasks/${taskId}`, { method: 'PATCH', body: { tripId, ...data } }),
    deleteTask: (taskId: number) =>
      apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE', query: { tripId } }),

    listGpxForLeg: (legId: number) => apiFetch(`/api/gpx`, { query: { tripId, legId } }),
    uploadGpx: (legId: number, file: File, name?: string, source?: string, sourceUrl?: string) => {
      const form = new FormData();
      form.append('file', file);
      form.append('tripId', String(tripId));
      form.append('legId', String(legId));
      if (name) form.append('name', name);
      if (source) form.append('source', source);
      if (sourceUrl) form.append('sourceUrl', sourceUrl);
      return apiFetch(`/api/gpx`, { body: form });
    },
    deleteGpx: (gpxId: number) =>
      apiFetch(`/api/gpx/${gpxId}`, { method: 'DELETE', query: { tripId } }),

    listPois: () => apiFetch(`/api/pois`, { query: { tripId } }),
  };
}
