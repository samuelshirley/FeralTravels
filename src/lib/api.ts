'use client';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
  const res = await fetch(buildUrl(path, opts.query), {
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
    throw new ApiError(res.status, message, data);
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
    addRouteLink: (routeId: number, payload: Record<string, unknown>) =>
      apiFetch(`/api/routes/${routeId}/links`, { body: { tripId, ...payload } }),
    deleteRouteLink: (routeId: number, linkId: number) =>
      apiFetch(`/api/routes/${routeId}/links`, {
        method: 'DELETE',
        query: { tripId, linkId },
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
