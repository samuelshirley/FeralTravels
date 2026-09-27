import { z } from 'zod';
import {
  requireUserId,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { setLegNotes } from '@/server/repos/trips';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 500;

const putSchema = z
  .object({
    notes: z
      .array(
        z
          .string()
          .trim()
          .min(1, 'A note cannot be empty')
          .max(MAX_NOTE_LENGTH, `A note is at most ${MAX_NOTE_LENGTH} characters`),
      )
      .max(MAX_NOTES, `A day holds at most ${MAX_NOTES} notes`),
  })
  .strict();

/**
 * PATCH /api/legs/:id/notes — replace a day's notes with the full list sent.
 * PATCH rather than PUT only because the web `apiFetch` speaks no PUT; the
 * semantics are a replace of the one field.
 *
 * The rest-day "+ Add note to this day" box and each note's delete control
 * both send the whole array: the client appends or removes locally, so there
 * is one write shape and no index arithmetic on the server. Plain user data —
 * no Anthropic spend, so no paywall, the same as the stop edit routes.
 *
 * A bad payload is a 400, not the 500 `errorResponse` would make of a thrown
 * ZodError. `error` is the first issue's sentence because it is what the
 * client's error toast shows.
 */
export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const legId = parseUUID(ctx.params.id);
    if (!legId)
      return Response.json({ error: 'Invalid leg id' }, { status: 400 });
    await assertLegOwnedByUser(legId, userId);
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid notes', issues: parsed.error.issues },
        { status: 400 },
      );
    const notes = await setLegNotes(legId, parsed.data.notes);
    return Response.json({ notes });
  } catch (err) {
    return errorResponse(err);
  }
}
