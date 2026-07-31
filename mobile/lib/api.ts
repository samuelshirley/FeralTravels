import { API_BASE_URL } from "@/lib/config";
import { getToken, clearToken } from "@/lib/auth";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** True when the server rejected our session (signed out / expired). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    if (res.status === 401) await clearToken();
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

// ---- Auth ----

export function requestOtp(email: string): Promise<{ ok: boolean }> {
  return request("/api/mobile/otp/send", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function verifyOtp(
  email: string,
  code: string
): Promise<{ token: string; expires: string; user: { id: string; email: string } }> {
  return request("/api/mobile/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

// ---- Trips ----

/** Subset of the web Trip type the mobile list needs (see src/types/trip.ts). */
export type TripSummary = {
  id: string;
  name: string;
  start_date_parsed: string;
  status: string;
  is_template: boolean;
  updated_at: string;
};

export function listTrips(): Promise<TripSummary[]> {
  return request("/api/trips");
}
