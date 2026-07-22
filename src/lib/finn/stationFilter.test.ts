import { describe, it, expect } from 'vitest';
import { classifyStation, filterUsableStations } from './stationFilter';
import type { FuelStation } from '@/lib/google/places';

function station(over: Partial<FuelStation> = {}): FuelStation {
  return {
    placeId: over.placeId ?? 'place/1',
    lat: over.lat ?? 59,
    lng: over.lng ?? 18,
    name: over.name ?? null,
    brand: over.brand ?? null,
    types: over.types ?? ['gas_station'],
    googleMapsUri: over.googleMapsUri ?? null,
  };
}

describe('classifyStation', () => {
  it('keeps a plain gas station (safety bias)', () => {
    expect(classifyStation(station({ name: 'Preem' })).usable).toBe(true);
  });

  it('rejects an explicit truck station by name (the ST1 Truck case)', () => {
    const r = classifyStation(station({ name: 'St1 Truck', brand: 'St1' }));
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('truck_only');
  });

  it('rejects LKW / camion named stations', () => {
    expect(classifyStation(station({ name: 'LKW Tankstelle' })).usable).toBe(false);
    expect(classifyStation(station({ name: 'Station Camion' })).usable).toBe(false);
  });

  it('does NOT false-positive on the town "Truckee"', () => {
    expect(classifyStation(station({ name: 'Shell Truckee', brand: 'Shell' })).usable).toBe(true);
  });

  it('rejects a dedicated truck_stop place type', () => {
    const r = classifyStation(station({ name: 'Rasti', types: ['truck_stop', 'point_of_interest'] }));
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('truck_only');
  });

  it('keeps a place typed both truck_stop AND gas_station (normal forecourt)', () => {
    expect(
      classifyStation(station({ name: 'OKQ8', types: ['gas_station', 'truck_stop'] })).usable
    ).toBe(true);
  });
});

describe('filterUsableStations', () => {
  it('partitions kept vs rejected with reasons', () => {
    const stations = [
      station({ placeId: 'a', name: 'Circle K' }),
      station({ placeId: 'b', name: 'St1 Truck' }),
      station({ placeId: 'c', name: 'Rasti', types: ['truck_stop'] }),
    ];
    const { kept, rejected } = filterUsableStations(stations);
    expect(kept.map((s) => s.placeId)).toEqual(['a']);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.eligibility.reason === 'truck_only')).toBe(true);
  });
});
