import { describe, it, expect } from 'vitest';
import { classifyStation, filterUsableStations } from './stationFilter';
import type { OsmFuelStation } from '@/lib/osm/overpass';

function station(
  tags: Record<string, string>,
  over: Partial<OsmFuelStation> = {}
): OsmFuelStation {
  return {
    osmId: over.osmId ?? 'node/1',
    lat: over.lat ?? 51,
    lng: over.lng ?? 7,
    name: over.name ?? tags['name'] ?? null,
    brand: over.brand ?? tags['brand'] ?? null,
    isMotorwayServices: over.isMotorwayServices ?? false,
    tags,
  };
}

describe('classifyStation', () => {
  it('keeps a plain untagged fuel station (safety bias)', () => {
    expect(classifyStation(station({ amenity: 'fuel' })).usable).toBe(true);
  });

  it('keeps a normal branded station with petrol + diesel', () => {
    const s = station({
      amenity: 'fuel',
      name: 'Aral',
      brand: 'Aral',
      'fuel:octane_95': 'yes',
      'fuel:diesel': 'yes',
    });
    expect(classifyStation(s).usable).toBe(true);
  });

  it('rejects an explicit truck station by name (the ST1 Truck case)', () => {
    const s = station({ amenity: 'fuel', name: 'St1 Truck', brand: 'St1' });
    const r = classifyStation(s);
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('truck_only');
  });

  it('rejects LKW / camion named stations', () => {
    expect(classifyStation(station({ amenity: 'fuel', name: 'LKW Tankstelle' })).usable).toBe(false);
    expect(classifyStation(station({ amenity: 'fuel', name: 'Station Camion' })).usable).toBe(false);
  });

  it('does NOT false-positive on the town "Truckee"', () => {
    const s = station({ amenity: 'fuel', name: 'Shell Truckee', brand: 'Shell' });
    expect(classifyStation(s).usable).toBe(true);
  });

  it('rejects private / depot access', () => {
    expect(classifyStation(station({ amenity: 'fuel', access: 'private' })).reason).toBe('private_access');
    expect(classifyStation(station({ amenity: 'fuel', access: 'customers' })).reason).toBe('private_access');
    expect(classifyStation(station({ amenity: 'fuel', access: 'no' })).reason).toBe('private_access');
  });

  it('keeps public access values', () => {
    expect(classifyStation(station({ amenity: 'fuel', access: 'yes' })).usable).toBe(true);
    expect(classifyStation(station({ amenity: 'fuel', access: 'permissive' })).usable).toBe(true);
  });

  it('rejects HGV diesel with no petrol', () => {
    const s = station({ amenity: 'fuel', 'fuel:HGV_diesel': 'yes', 'fuel:diesel': 'yes' });
    expect(classifyStation(s).reason).toBe('truck_only');
  });

  it('rejects an explicitly diesel-only forecourt (petrol=no)', () => {
    const s = station({
      amenity: 'fuel',
      'fuel:diesel': 'yes',
      'fuel:octane_95': 'no',
      'fuel:octane_98': 'no',
    });
    expect(classifyStation(s).reason).toBe('truck_only');
  });

  it('rejects hgv=designated when no petrol is offered', () => {
    const s = station({ amenity: 'fuel', hgv: 'designated', 'fuel:diesel': 'yes' });
    expect(classifyStation(s).reason).toBe('truck_only');
  });

  it('keeps a big highway station that allows HGV but also sells petrol', () => {
    const s = station({
      amenity: 'fuel',
      hgv: 'designated',
      'fuel:diesel': 'yes',
      'fuel:octane_95': 'yes',
    });
    expect(classifyStation(s).usable).toBe(true);
  });

  it('does not exclude a station that simply omits petrol tags', () => {
    // diesel tagged, petrol neither yes nor no, no HGV signal → keep.
    const s = station({ amenity: 'fuel', 'fuel:diesel': 'yes' });
    expect(classifyStation(s).usable).toBe(true);
  });
});

describe('filterUsableStations', () => {
  it('partitions kept vs rejected and preserves reasons', () => {
    const stations = [
      station({ amenity: 'fuel', name: 'Aral', 'fuel:octane_95': 'yes' }, { osmId: 'node/1' }),
      station({ amenity: 'fuel', name: 'St1 Truck' }, { osmId: 'node/2' }),
      station({ amenity: 'fuel', access: 'private' }, { osmId: 'node/3' }),
    ];
    const { kept, rejected } = filterUsableStations(stations);
    expect(kept.map((s) => s.osmId)).toEqual(['node/1']);
    expect(rejected.map((r) => r.station.osmId).sort()).toEqual(['node/2', 'node/3']);
    expect(rejected.find((r) => r.station.osmId === 'node/2')?.eligibility.reason).toBe('truck_only');
  });
});
