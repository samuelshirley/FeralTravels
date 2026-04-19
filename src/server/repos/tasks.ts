import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { tasks, legs } from '@/server/db/schema';
import type { Task } from '@/types/trip';
import { rowMappers } from './trips';

export async function getTasksForTrip(tripId: number): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.tripId, tripId))
    .orderBy(asc(tasks.createdAt));
  return rows.map(rowMappers.taskRow).sort((a, b) => {
    const ao = a.status === 'open' ? 0 : 1;
    const bo = b.status === 'open' ? 0 : 1;
    return ao - bo || a.created_at.localeCompare(b.created_at);
  });
}

export async function getTasksForLeg(legId: number): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.legId, legId))
    .orderBy(asc(tasks.createdAt));
  return rows.map(rowMappers.taskRow).sort((a, b) => {
    const ao = a.status === 'open' ? 0 : 1;
    const bo = b.status === 'open' ? 0 : 1;
    return ao - bo || a.created_at.localeCompare(b.created_at);
  });
}

export async function getTask(id: number): Promise<Task | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowMappers.taskRow(rows[0]);
}

export async function addTask(input: {
  trip_id: number;
  leg_id?: number | null;
  title: string;
  description?: string | null;
  priority?: string | null;
  status?: string | null;
  reference_url?: string | null;
  reference_label?: string | null;
  reference_phone?: string | null;
  created_by?: string | null;
  due_at?: string | null;
}): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      tripId: input.trip_id,
      legId: input.leg_id ?? null,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'normal',
      status: input.status ?? 'open',
      referenceUrl: input.reference_url ?? null,
      referenceLabel: input.reference_label ?? null,
      referencePhone: input.reference_phone ?? null,
      createdBy: input.created_by ?? 'user',
      dueAt: input.due_at ? new Date(input.due_at) : null,
    })
    .returning();
  return rowMappers.taskRow(row);
}

export async function updateTask(
  id: number,
  data: Partial<{
    title: string;
    description: string | null;
    priority: string;
    status: string;
    reference_url: string | null;
    reference_label: string | null;
    reference_phone: string | null;
    answer: string | null;
    answer_source_url: string | null;
    answer_image_url: string | null;
    due_at: string | null;
  }>
): Promise<Task | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.title !== undefined) update.title = data.title;
  if (data.description !== undefined) update.description = data.description;
  if (data.priority !== undefined) update.priority = data.priority;
  if (data.status !== undefined) update.status = data.status;
  if (data.reference_url !== undefined) update.referenceUrl = data.reference_url;
  if (data.reference_label !== undefined) update.referenceLabel = data.reference_label;
  if (data.reference_phone !== undefined) update.referencePhone = data.reference_phone;
  if (data.answer !== undefined) update.answer = data.answer;
  if (data.answer_source_url !== undefined) update.answerSourceUrl = data.answer_source_url;
  if (data.answer_image_url !== undefined) update.answerImageUrl = data.answer_image_url;
  if (data.due_at !== undefined) update.dueAt = data.due_at ? new Date(data.due_at) : null;
  await db.update(tasks).set(update).where(eq(tasks.id, id));
  return getTask(id);
}

export async function deleteTask(id: number): Promise<boolean> {
  const result = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  return result.length > 0;
}

export async function getLegTripId(legId: number): Promise<number | null> {
  const r = await db.select({ tripId: legs.tripId }).from(legs).where(eq(legs.id, legId)).limit(1);
  return r[0]?.tripId ?? null;
}
