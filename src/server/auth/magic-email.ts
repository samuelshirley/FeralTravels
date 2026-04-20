import 'server-only';

/**
 * HTML for the magic-link sign-in email. Plain string template (no JSX) so
 * it can run in the Edge runtime if Auth.js ever moves the provider there.
 */
export function renderMagicEmail({ url, to }: { url: string; to: string }): string {
  const escapedUrl = escapeHtml(url);
  const escapedTo = escapeHtml(to);
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>Sign in to Trip Planner</title>
  </head>
  <body style="margin:0;padding:0;background:#0d0d0d;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#171717;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:32px;">
            <tr>
              <td style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:0.16em;color:rgba(255,255,255,0.45);text-transform:uppercase;padding-bottom:6px;">
                Trip Planner
              </td>
            </tr>
            <tr>
              <td style="font-size:22px;font-weight:700;color:#ffffff;padding-bottom:14px;">
                Sign in to your account
              </td>
            </tr>
            <tr>
              <td style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.7);padding-bottom:24px;">
                Tap the button below to finish signing in as <strong>${escapedTo}</strong>. The link is valid for 24 hours.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <a href="${escapedUrl}" style="display:inline-block;background:#7CB5E8;color:#000000;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">
                  Sign in to Trip Planner
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;color:rgba(255,255,255,0.4);line-height:1.5;padding-bottom:12px;">
                Or copy and paste this URL:
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#7CB5E8;word-break:break-all;padding-bottom:24px;">
                <a href="${escapedUrl}" style="color:#7CB5E8;text-decoration:underline;">${escapedUrl}</a>
              </td>
            </tr>
            <tr>
              <td style="font-size:11px;color:rgba(255,255,255,0.35);line-height:1.5;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">
                If you didn't request this email, you can safely ignore it. Someone may have entered your address by mistake.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
