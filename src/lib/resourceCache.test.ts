/**
 * The resource cache's own rules: what makes a screen render at once, and
 * what keeps one account's data out of another's.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_SNAPSHOT_VERSION,
  MAX_CACHE_ENTRIES,
  cacheKeys,
  configureResourceCachePersistence,
  getCached,
  removeCached,
  resetResourceCache,
  revalidate,
  setCached,
  subscribeCached,
  updateCached,
  type CachePersistence,
} from './resourceCache';

/** An in-memory stand-in for the disk, counting what reaches it. */
function memoryDisk(initial: string | null = null) {
  const disk = {
    content: initial,
    saves: 0,
    clears: 0,
  };
  const backend: CachePersistence = {
    load: () => disk.content,
    save: (s) => {
      disk.saves += 1;
      disk.content = s;
    },
    clear: () => {
      disk.clears += 1;
      disk.content = null;
    },
  };
  return { disk, backend };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  configureResourceCachePersistence(null);
  resetResourceCache();
});

describe('a second visit renders without waiting', () => {
  it('holds what the server last said, synchronously', async () => {
    expect(getCached(cacheKeys.trips)).toBeUndefined();
    await revalidate(cacheKeys.trips, async () => [{ id: 't1' }]);
    // The next mount reads this before any request goes out: no spinner.
    expect(getCached(cacheKeys.trips)).toEqual([{ id: 't1' }]);
  });

  it('a fresh answer replaces the held one and notifies readers', async () => {
    setCached('k', { n: 1 });
    let calls = 0;
    subscribeCached('k', () => (calls += 1));
    await revalidate('k', async () => ({ n: 2 }));
    expect(getCached('k')).toEqual({ n: 2 });
    expect(calls).toBe(1);
  });

  it('an identical answer notifies nobody (the 2 s fuel poll must not re-render the map)', async () => {
    setCached('k', { legs: [1, 2] });
    let calls = 0;
    subscribeCached('k', () => (calls += 1));
    await revalidate('k', async () => ({ legs: [1, 2] }));
    expect(calls).toBe(0);
  });

  it('concurrent revalidations of one key share one request', async () => {
    const d = deferred<number>();
    let requests = 0;
    const fetcher = () => {
      requests += 1;
      return d.promise;
    };
    const a = revalidate('k', fetcher);
    const b = revalidate('k', fetcher);
    d.resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(requests).toBe(1);
  });
});

describe('a bad answer never blanks a screen', () => {
  it('a failed request keeps the held value and rejects to the caller', async () => {
    setCached('k', { ok: true });
    await expect(revalidate('k', async () => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline'
    );
    expect(getCached('k')).toEqual({ ok: true });
  });

  it('a body the caller rejects is not stored', async () => {
    setCached('k', { legs: [] });
    await revalidate('k', async () => ({ error: 'nope' }) as unknown as { legs: [] }, (v) => 'legs' in v);
    expect(getCached('k')).toEqual({ legs: [] });
  });
});

describe('account boundary', () => {
  it('reset empties memory and disk and tells every reader', () => {
    const { disk, backend } = memoryDisk();
    configureResourceCachePersistence(backend);
    setCached(cacheKeys.trips, [{ id: 'a' }]);
    let told = 0;
    subscribeCached(cacheKeys.trips, () => (told += 1));
    resetResourceCache();
    expect(getCached(cacheKeys.trips)).toBeUndefined();
    expect(disk.content).toBeNull();
    expect(told).toBe(1);
  });

  it("an answer that lands after the account changed is not stored for the next account", async () => {
    const d = deferred<string[]>();
    const pending = revalidate(cacheKeys.trips, () => d.promise);
    resetResourceCache(); // signed out while the list was loading
    d.resolve(['previous-account-trip']);
    // The original caller still gets its answer; the cache does not keep it.
    expect(await pending).toEqual(['previous-account-trip']);
    expect(getCached(cacheKeys.trips)).toBeUndefined();
  });

  it('after a reset a new request goes out rather than joining the old one', async () => {
    const old = deferred<number>();
    void revalidate('k', () => old.promise);
    resetResourceCache();
    let fresh = 0;
    await revalidate('k', async () => {
      fresh += 1;
      return 2;
    });
    expect(fresh).toBe(1);
    expect(getCached('k')).toBe(2);
    old.resolve(1);
  });
});

describe('disk', () => {
  it('survives a relaunch: what was saved is there before any request', () => {
    const { disk, backend } = memoryDisk();
    configureResourceCachePersistence(backend);
    setCached(cacheKeys.trip('t1'), { id: 't1', legs: [] });

    // "Relaunch": module state gone, the file still there.
    configureResourceCachePersistence(null);
    const saved = disk.content;
    resetResourceCache();
    configureResourceCachePersistence(memoryDisk(saved).backend);
    expect(getCached(cacheKeys.trip('t1'))).toEqual({ id: 't1', legs: [] });
  });

  it('writes to disk only when something changed', () => {
    const { disk, backend } = memoryDisk();
    configureResourceCachePersistence(backend);
    setCached('k', { a: 1 });
    setCached('k', { a: 1 });
    setCached('k', { a: 1 });
    expect(disk.saves).toBe(1);
  });

  it.each([
    ['garbage', 'not json{'],
    ['another version', JSON.stringify({ v: CACHE_SNAPSHOT_VERSION + 1, entries: { k: { at: 1, value: 1 } } })],
    ['no entries', JSON.stringify({ v: CACHE_SNAPSHOT_VERSION })],
  ])('a snapshot that is %s is ignored, never thrown', (_label, raw) => {
    expect(() => configureResourceCachePersistence(memoryDisk(raw).backend)).not.toThrow();
    expect(getCached('k')).toBeUndefined();
  });

  it('a backend that throws costs a cold load, not a crash', () => {
    const exploding: CachePersistence = {
      load: () => {
        throw new Error('no native module');
      },
      save: () => {
        throw new Error('disk full');
      },
      clear: () => {
        throw new Error('gone');
      },
    };
    expect(() => configureResourceCachePersistence(exploding)).not.toThrow();
    expect(() => setCached('k', 1)).not.toThrow();
    expect(getCached('k')).toBe(1);
    expect(() => resetResourceCache()).not.toThrow();
  });

  it(`keeps at most ${MAX_CACHE_ENTRIES} entries, dropping the oldest`, () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) setCached(`trip:${i}`, { i });
    expect(getCached('trip:0')).toBeUndefined();
    expect(getCached('trip:4')).toBeUndefined();
    expect(getCached('trip:5')).toEqual({ i: 5 });
    expect(getCached(`trip:${MAX_CACHE_ENTRIES + 4}`)).toEqual({ i: MAX_CACHE_ENTRIES + 4 });
  });
});

describe('local edits', () => {
  it('updateCached rewrites in place and can remove', () => {
    setCached<string[]>(cacheKeys.trips, ['a', 'b']);
    updateCached<string[]>(cacheKeys.trips, (prev) => prev?.filter((t) => t !== 'a'));
    expect(getCached(cacheKeys.trips)).toEqual(['b']);
    updateCached(cacheKeys.trips, () => undefined);
    expect(getCached(cacheKeys.trips)).toBeUndefined();
  });

  it('removeCached of a missing key is a no-op', () => {
    expect(() => removeCached('nope')).not.toThrow();
  });

  it('a stored object is a copy, so mutating the original does not leak in', () => {
    const value = { name: 'before' };
    setCached('k', value);
    value.name = 'after';
    expect(getCached<{ name: string }>('k')?.name).toBe('before');
  });
});
