import { useCallback, useSyncExternalStore } from 'react';

/**
 * The app's memory of what the server last said, keyed by resource:
 * MODULE state, optionally written through to disk.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * Every screen held its server data in `useState`, which starts empty on every
 * mount. So every navigation was a cold load: back to the trips list was a
 * blank screen and a spinner, re-opening a trip was "Loading trip…" for a
 * network round trip, and Settings re-fetched every section every time
 * (screen recording, iPhone, 2026-10-22: ~130 ms of spinner on the list and
 * ~200 ms of "Loading trip" AFTER each slide animation had finished).
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * Stale-while-revalidate. A screen renders whatever is here at once, and still
 * asks the server every time it mounts or refocuses. The server stays the
 * authority, so nothing here can be wrong for longer than one round trip.
 * The cache only removes the empty frame.
 *
 * ── Account boundary ───────────────────────────────────────────────────────
 *
 * `resetResourceCache()` empties memory AND disk. The native client calls it
 * on every sign-out and every sign-in (`mobile/lib/auth.ts`), so one account
 * can never be shown another's trips. A fetch that was in flight when the
 * account changed is dropped on arrival (`generation`), rather than writing the
 * previous account's answer into the new account's cache.
 *
 * Pure TypeScript with an injected persistence backend, so the root vitest
 * project can execute the real module (`resourceCache.test.ts`). The native
 * disk backend is `mobile/lib/cache.ts`.
 */

export interface CachePersistence {
  /** The last saved snapshot, or null when there is none. Must not throw. */
  load(): string | null;
  save(snapshot: string): void;
  clear(): void;
}

interface Entry {
  value: unknown;
  /** The value as JSON: the change check, and what goes to disk. */
  json: string;
  /** When it was last written, for eviction. */
  at: number;
}

/** Bump when the snapshot shape changes; an older snapshot is then ignored. */
export const CACHE_SNAPSHOT_VERSION = 1;

/**
 * Upper bound on entries kept, oldest evicted first. A trip is two entries
 * (`trip:` and `pois:`), so this holds the most recent ~25 trips plus the
 * handful of account-level resources. It bounds the file on disk; it does
 * not change what any screen shows, because a screen always revalidates.
 */
export const MAX_CACHE_ENTRIES = 60;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<unknown>>();
let persistence: CachePersistence | null = null;
let generation = 0;
let clock = 0;

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function persist(): void {
  if (!persistence) return;
  const snapshot: Record<string, { at: number; value: unknown }> = {};
  for (const [key, entry] of entries) snapshot[key] = { at: entry.at, value: entry.value };
  try {
    persistence.save(JSON.stringify({ v: CACHE_SNAPSHOT_VERSION, entries: snapshot }));
  } catch {
    // Disk full, or the backend is gone. The in-memory copy still serves this
    // session; the next launch is merely a cold one.
  }
}

function evict(): void {
  if (entries.size <= MAX_CACHE_ENTRIES) return;
  const oldestFirst = [...entries].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldestFirst.slice(0, entries.size - MAX_CACHE_ENTRIES)) {
    entries.delete(key);
    emit(key);
  }
}

/**
 * Install the disk backend and load what it holds. Call once, at startup,
 * before the first screen reads. A snapshot that is missing, unreadable, from
 * another version, or malformed is ignored, never thrown: a broken cache file
 * must cost a cold load, not a launch.
 */
export function configureResourceCachePersistence(backend: CachePersistence | null): void {
  persistence = backend;
  if (!backend) return;
  let raw: string | null = null;
  try {
    raw = backend.load();
  } catch {
    raw = null;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      entries?: Record<string, { at?: unknown; value?: unknown }>;
    };
    if (parsed?.v !== CACHE_SNAPSHOT_VERSION || !parsed.entries) return;
    for (const [key, item] of Object.entries(parsed.entries)) {
      if (!item || item.value === undefined || typeof item.at !== 'number') continue;
      if (entries.has(key)) continue; // something newer landed this session
      entries.set(key, { value: item.value, json: JSON.stringify(item.value), at: item.at });
      clock = Math.max(clock, item.at);
      emit(key);
    }
  } catch {
    try {
      backend.clear();
    } catch {
      // Nothing more to do; the next save overwrites it.
    }
  }
}

export function getCached<T>(key: string): T | undefined {
  return entries.get(key)?.value as T | undefined;
}

/** Store a value. A write identical to what is held notifies nobody. */
export function setCached<T>(key: string, value: T): void {
  if (value === undefined) {
    removeCached(key);
    return;
  }
  const json = JSON.stringify(value);
  const existing = entries.get(key);
  if (existing && existing.json === json) return;
  // A fresh object, so a reader's identity check sees the change even when a
  // caller mutated and re-stored the same object.
  entries.set(key, { value: JSON.parse(json) as T, json, at: ++clock });
  evict();
  emit(key);
  persist();
}

/** Read-modify-write. Returning undefined removes the entry. */
export function updateCached<T>(key: string, fn: (prev: T | undefined) => T | undefined): void {
  const next = fn(getCached<T>(key));
  if (next === undefined) removeCached(key);
  else setCached(key, next);
}

export function removeCached(key: string): void {
  if (!entries.delete(key)) return;
  emit(key);
  persist();
}

/**
 * Ask the server and store the answer. Concurrent calls for one key share a
 * single request. Rejects exactly as the fetcher does, so each screen keeps its
 * own error handling (a 401 still routes to sign-in).
 *
 * `accept` rejects a malformed body without touching what is held: a bad
 * response must not blank a screen the user is already looking at. An answer
 * that lands after `resetResourceCache()` is returned to its caller but not
 * stored, because it belongs to the account that just left.
 */
export function revalidate<T>(
  key: string,
  fetcher: () => Promise<T>,
  accept: (value: T) => boolean = () => true
): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const startedIn = generation;
  const request: Promise<T> = fetcher().then(
    (value) => {
      if (inflight.get(key) === request) inflight.delete(key);
      if (startedIn === generation && value !== undefined && accept(value)) setCached(key, value);
      return value;
    },
    (err: unknown) => {
      if (inflight.get(key) === request) inflight.delete(key);
      throw err;
    }
  );
  inflight.set(key, request);
  return request;
}

/** Sign-out, sign-in, account deletion, and test isolation. Memory AND disk. */
export function resetResourceCache(): void {
  generation += 1;
  inflight.clear();
  const keys = [...entries.keys()];
  entries.clear();
  for (const key of keys) emit(key);
  try {
    persistence?.clear();
  } catch {
    // Best effort. The file is keyed to nothing and rewritten on next save.
  }
}

export function subscribeCached(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** The held value for `key`, re-rendering when it changes. */
export function useCached<T>(key: string): T | undefined {
  const subscribe = useCallback((listener: () => void) => subscribeCached(key, listener), [key]);
  const read = useCallback(() => getCached<T>(key), [key]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Keys, in one place, so a typo cannot split one resource into two. */
export const cacheKeys = {
  trips: 'trips',
  me: 'me',
  identity: 'identity',
  entitlement: 'entitlement',
  vehicles: 'vehicles',
  trip: (tripId: string) => `trip:${tripId}`,
  pois: (tripId: string) => `pois:${tripId}`,
} as const;
