import { z } from 'zod';
import {
  requireUserId,
  assertTaskOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { updateTask, deleteTask, getTask } from '@/server/repos/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  tripId: z.number().int().positive().optional(),
  title: z.string().optional(),
  description: z.string().nullish(),
  priority: z.string().optional(),
  status: z.string().optional(),
  reference_url: z.string().nullish(),
  reference_label: z.string().nullish(),
  reference_phone: z.string().nullish(),
  answer: z.string().nullish(),
  answer_source_url: z.string().nullish(),
  answer_image_url: z.string().nullish(),
  due_at: z.string().nullish(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertTaskOwnedByUser(id, userId);
    const body = patchSchema.parse(await request.json());
    const { tripId: _t, ...data } = body;
    const task = await updateTask(id, data as any);
    if (!task) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(task);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertTaskOwnedByUser(id, userId);
    if (!(await getTask(id))) return Response.json({ error: 'Not found' }, { status: 404 });
    await deleteTask(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
