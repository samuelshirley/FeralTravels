import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { routes, routeLinks } from '@/server/db/schema';
import type { RouteWithLinks, RouteLink, RouteLinkType, Route } from '@/types/trip';
import { rowMappers } from './trips';

export async function getRoutesForLeg(legId: number): Promise<RouteWithLinks[]> {
  const routeRows = await db
    .select()
    .from(routes)
    .where(eq(routes.legId, legId))
    .orderBy(asc(routes.sortOrder), asc(routes.id));
  if (routeRows.length === 0) return [];

  const routeIds = routeRows.map((r) => r.id);
  const linkRows = await db
    .select()
    .from(routeLinks)
    .where(sql`${routeLinks.routeId} = ANY(${routeIds})`)
    .orderBy(asc(routeLinks.id));

  const linksById = new Map<number, RouteLink[]>();
  for (const r of linkRows) {
    const arr = linksById.get(r.routeId) || [];
    arr.push(rowMappers.routeLinkRow(r));
    linksById.set(r.routeId, arr);
  }
  return routeRows.map((r) => ({ ...rowMappers.routeRow(r), links: linksById.get(r.id) || [] }));
}

export async function getRoute(id: number): Promise<RouteWithLinks | null> {
  const r = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
  if (r.length === 0) return null;
  const lnks = await db
    .select()
    .from(routeLinks)
    .where(eq(routeLinks.routeId, id))
    .orderBy(asc(routeLinks.id));
  return { ...rowMappers.routeRow(r[0]), links: lnks.map(rowMappers.routeLinkRow) };
}

export async function addRoute(input: {
  leg_id: number;
  label: string;
  description?: string | null;
  distance_km?: number | null;
  surface?: string | null;
  status?: string | null;
  gpx_trail_id?: number | null;
  sort_order?: number | null;
  links?: Array<{ label?: string; url: string; type?: string }>;
}): Promise<RouteWithLinks> {
  const next = await db
    .select({ next: sql<number>`COALESCE(MAX(${routes.sortOrder}), -1) + 1` })
    .from(routes)
    .where(eq(routes.legId, input.leg_id));
  const sortOrder = input.sort_order ?? next[0].next ?? 0;

  const [row] = await db
    .insert(routes)
    .values({
      legId: input.leg_id,
      sortOrder,
      label: input.label,
      description: input.description ?? null,
      distanceKm: input.distance_km ?? null,
      surface: input.surface ?? null,
      status: input.status ?? 'option',
      gpxTrailId: input.gpx_trail_id ?? null,
    })
    .returning();

  if (Array.isArray(input.links) && input.links.length > 0) {
    await db.insert(routeLinks).values(
      input.links
        .filter((l) => !!l?.url)
        .map((l) => ({
          routeId: row.id,
          label: l.label || l.type || 'link',
          url: l.url,
          type: l.type || 'other',
        }))
    );
  }

  return (await getRoute(row.id))!;
}

export async function updateRoute(
  id: number,
  data: Partial<{
    label: string;
    description: string | null;
    distance_km: number | null;
    surface: string | null;
    status: string;
    gpx_trail_id: number | null;
    sort_order: number;
  }>
): Promise<RouteWithLinks | null> {
  const update: Record<string, unknown> = {};
  if (data.label !== undefined) update.label = data.label;
  if (data.description !== undefined) update.description = data.description;
  if (data.distance_km !== undefined) update.distanceKm = data.distance_km;
  if (data.surface !== undefined) update.surface = data.surface;
  if (data.status !== undefined) update.status = data.status;
  if (data.gpx_trail_id !== undefined) update.gpxTrailId = data.gpx_trail_id;
  if (data.sort_order !== undefined) update.sortOrder = data.sort_order;
  if (Object.keys(update).length > 0) {
    await db.update(routes).set(update).where(eq(routes.id, id));
  }
  return getRoute(id);
}

export async function deleteRoute(id: number): Promise<boolean> {
  const result = await db.delete(routes).where(eq(routes.id, id)).returning({ id: routes.id });
  return result.length > 0;
}

export async function addRouteLink(input: {
  route_id: number;
  label: string;
  url: string;
  type?: string;
}): Promise<RouteLink> {
  const [row] = await db
    .insert(routeLinks)
    .values({
      routeId: input.route_id,
      label: input.label,
      url: input.url,
      type: input.type || 'other',
    })
    .returning();
  return rowMappers.routeLinkRow(row);
}

export async function deleteRouteLink(id: number): Promise<boolean> {
  const result = await db
    .delete(routeLinks)
    .where(eq(routeLinks.id, id))
    .returning({ id: routeLinks.id });
  return result.length > 0;
}
