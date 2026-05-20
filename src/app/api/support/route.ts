import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Resend } from 'resend';
import { auth } from '@/server/auth';

const supportSchema = z.object({
  message: z.string().min(1, 'Message is required').max(5000),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = supportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    console.error('[api/support] Missing AUTH_RESEND_KEY');
    return NextResponse.json({ error: 'Email not configured' }, { status: 500 });
  }

  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) {
    console.error('[api/support] Missing AUTH_EMAIL_FROM');
    return NextResponse.json({ error: 'Email not configured' }, { status: 500 });
  }

  const userName = session.user.name || 'Unknown';
  const userEmail = session.user.email || 'Unknown';

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: 'support@feralltravels.com',
    replyTo: userEmail,
    subject: `Support request from ${userName}`,
    text: [
      `Support request from ${userName} (${userEmail})`,
      '',
      '---',
      '',
      parsed.data.message,
    ].join('\n'),
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p><strong>From:</strong> ${escapeHtml(userName)} (${escapeHtml(userEmail)})</p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;" />
        <div style="white-space: pre-wrap;">${escapeHtml(parsed.data.message)}</div>
      </div>
    `,
  });

  if (result.error) {
    console.error('[api/support] Resend error', result.error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
