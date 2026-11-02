import { z } from 'zod';
import { NotFoundError, requireAdmin, errorResponse } from '@/server/auth/guards';
import { deleteFeatureRequest, updateFeatureRequest } from '@/server/repos/featureRequests';
import { parseUUID } from '@/lib/validation';
import {
  FEATURE_REQUEST_BODY_MAX,
  FEATURE_REQUEST_REPLY_MAX,
  FEATURE_REQUEST_STATUSES,
  FEATURE_REQUEST_TITLE_MAX,
} from '@/lib/featureRequests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An empty string means "none": the admin cleared the box. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

/**
 * One request's status, reply, title or body. Strict: an unknown key is a 400,
 * and so is a body that changes nothing.
 */
const patchSchema = z
  .object({
    status: z.enum(FEATURE_REQUEST_STATUSES).optional(),
    reply: optionalText(FEATURE_REQUEST_REPLY_MAX).optional(),
    title: z.string().trim().min(1).max(FEATURE_REQUEST_TITLE_MAX).optional(),
    body: optionalText(FEATURE_REQUEST_BODY_MAX).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

function idOf(ctx: { params: { id: string } }): string {
  const id = parseUUID(ctx.params.id);
  if (!id) throw new NotFoundError('not_found');
  return id;
}

export async function PATCH(request: Request, ctx: { params: { id: string } }) {
  try {
    await requireAdmin();
    const id = idOf(ctx);
    const patch = patchSchema.parse(await request.json());
    if (!(await updateFeatureRequest(id, patch))) throw new NotFoundError('not_found');
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Deletes the request and every vote on it. */
export async function DELETE(_request: Request, ctx: { params: { id: string } }) {
  try {
    await requireAdmin();
    const id = idOf(ctx);
    if (!(await deleteFeatureRequest(id))) throw new NotFoundError('not_found');
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
