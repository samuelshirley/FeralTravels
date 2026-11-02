/**
 * `useCached` in a real React render: the first render already has what the
 * cache holds (no empty frame), a refresh re-renders in place, and a reset
 * empties every reader at once.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureResourceCachePersistence,
  resetResourceCache,
  revalidate,
  setCached,
  useCached,
} from './resourceCache';

beforeEach(() => {
  configureResourceCachePersistence(null);
  resetResourceCache();
});

describe('useCached', () => {
  it('the FIRST render of a remount already has the held value', () => {
    setCached('trips', ['t1']);
    const renders: Array<string[] | undefined> = [];
    renderHook(() => {
      const v = useCached<string[]>('trips');
      renders.push(v);
      return v;
    });
    expect(renders[0]).toEqual(['t1']);
  });

  it('a refresh re-renders the reader with the new value', async () => {
    setCached('trips', ['t1']);
    const { result } = renderHook(() => useCached<string[]>('trips'));
    await act(async () => {
      await revalidate('trips', async () => ['t1', 't2']);
    });
    expect(result.current).toEqual(['t1', 't2']);
  });

  it('sign-out empties a mounted reader', () => {
    setCached('trips', ['t1']);
    const { result } = renderHook(() => useCached<string[]>('trips'));
    act(() => resetResourceCache());
    expect(result.current).toBeUndefined();
  });

  it('switching key reads the other resource', () => {
    setCached('trip:a', { id: 'a' });
    setCached('trip:b', { id: 'b' });
    const { result, rerender } = renderHook(({ k }) => useCached<{ id: string }>(k), {
      initialProps: { k: 'trip:a' },
    });
    expect(result.current?.id).toBe('a');
    rerender({ k: 'trip:b' });
    expect(result.current?.id).toBe('b');
  });
});
