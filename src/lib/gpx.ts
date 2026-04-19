import path from 'path';
import fs from 'fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { gpx as gpxToGeoJson } from '@tmcw/togeojson';

export const GPX_DIR = process.env.GPX_DIR || path.join(process.cwd(), 'src', 'data', 'gpx');

export async function ensureGpxDir() {
  await fs.mkdir(GPX_DIR, { recursive: true });
}

export async function readGpxAsGeoJson(filename: string) {
  const safe = path.basename(filename);
  const fullPath = path.join(GPX_DIR, safe);
  const xml = await fs.readFile(fullPath, 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // @tmcw/togeojson types DOM differently than xmldom; cast to any to bridge
  return gpxToGeoJson(doc as any);
}

export async function writeGpxFile(filename: string, contents: Buffer | string): Promise<string> {
  await ensureGpxDir();
  const safe = sanitizeFilename(filename);
  const fullPath = path.join(GPX_DIR, safe);
  await fs.writeFile(fullPath, contents);
  return safe;
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!/\.gpx$/i.test(base)) return `${base}.gpx`;
  return base;
}

export function approxDistanceKm(geojson: ReturnType<typeof gpxToGeoJson>): number {
  let total = 0;
  for (const f of geojson.features) {
    const lines: number[][][] = [];
    if (f.geometry?.type === 'LineString') lines.push(f.geometry.coordinates as number[][]);
    else if (f.geometry?.type === 'MultiLineString')
      lines.push(...(f.geometry.coordinates as number[][][]));
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        total += haversineKm(line[i - 1], line[i]);
      }
    }
  }
  return Math.round(total * 10) / 10;
}

function haversineKm(a: number[], b: number[]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
