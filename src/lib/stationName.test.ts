import { describe, expect, it, vi } from 'vitest';
import {
  STATION_NAME_CAP_REACHED,
  STATION_NAME_UNAVAILABLE,
  loadStationName,
  namedFuelStopLabel,
  stationNameErrorCopy,
  stationNamePath,
} from './stationName';

/**
 * Both stop cards call this one loader on a tap (web StopsSection, iOS
 * StopsSection — held at source level by stationNameGuard.test.ts). Its whole
 * promise: never throw, never a blank, always a line saying why.
 */
describe('loadStationName', () => {
  it('asks the stop’s own route and returns the name', async () => {
    const fetchJson = vi.fn(async () => ({ name: '  Repsol Librilla A-7 ' }));
    expect(await loadStationName(fetchJson, 'stop-1')).toEqual({ status: 'ok', name: 'Repsol Librilla A-7' });
    expect(fetchJson).toHaveBeenCalledWith('/api/stops/stop-1/place-name', { skipGlobalErrorReport: true });
  });

  it('a 502 becomes the unavailable line', async () => {
    const err = Object.assign(new Error('x'), { status: 502, payload: { code: STATION_NAME_UNAVAILABLE } });
    expect(await loadStationName(async () => { throw err; }, 's')).toEqual({
      status: 'failed',
      message: stationNameErrorCopy(STATION_NAME_UNAVAILABLE),
    });
  });

  it('the daily cap gets its own line', async () => {
    const err = Object.assign(new Error('x'), { status: 429, payload: { code: STATION_NAME_CAP_REACHED } });
    const r = await loadStationName(async () => { throw err; }, 's');
    expect(r).toEqual({ status: 'failed', message: stationNameErrorCopy(STATION_NAME_CAP_REACHED) });
    expect(stationNameErrorCopy(STATION_NAME_CAP_REACHED)).not.toBe(stationNameErrorCopy(null));
  });

  it('a network error, or a body with no name, is a failure — never a blank', async () => {
    expect((await loadStationName(async () => { throw new TypeError('offline'); }, 's')).status).toBe('failed');
    expect((await loadStationName(async () => ({ name: '   ' }), 's')).status).toBe('failed');
    expect((await loadStationName(async () => null, 's')).status).toBe('failed');
  });
});

describe('namedFuelStopLabel', () => {
  it('puts the name where "Fuel stop" was, distance kept in the user’s units', () => {
    expect(namedFuelStopLabel('Repsol', 89, 'metric')).toBe('Repsol · 89 km');
    expect(namedFuelStopLabel('Repsol', 89, 'imperial')).toMatch(/^Repsol · 55 mi$/);
    expect(namedFuelStopLabel('Repsol', null, 'metric')).toBe('Repsol');
  });
});

describe('stationNamePath', () => {
  it('encodes the id', () => {
    expect(stationNamePath('a/b')).toBe('/api/stops/a%2Fb/place-name');
  });
});
