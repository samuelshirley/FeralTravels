/**
 * Helpers for route-handler unit tests. A test file still declares its own
 * `vi.mock` calls (they are hoisted per file), and keeps the REAL
 * `errorResponse` so a status asserted here is the status a client gets —
 * including the ZodError → 400 branch.
 */

export const UUID = {
  owner: '00000000-0000-4000-8000-0000000000a1',
  trip: '00000000-0000-4000-8000-0000000000b1',
  otherTrip: '00000000-0000-4000-8000-0000000000b2',
  leg: '00000000-0000-4000-8000-0000000000c1',
  route: '00000000-0000-4000-8000-0000000000d1',
  link: '00000000-0000-4000-8000-0000000000e1',
  stop: '00000000-0000-4000-8000-0000000000f1',
} as const;

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`https://example.test${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
