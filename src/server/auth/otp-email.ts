import 'server-only';

/**
 * HTML for the OTP code sign-in email. Shows a large 6-digit code instead of
 * a magic link — the user types the code on the /login/verify screen.
 */
export function renderOtpEmail({ code, to, domain }: { code: string; to: string; domain?: string }): string {
  const escapedTo = escapeHtml(to);
  // Render the code with letter-spacing so each digit is clearly separated.
  // Split into two groups of three (e.g. "123 456") for readability.
  const displayCode = `${code.slice(0, 3)} ${code.slice(3)}`;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>Sign in to Feral Travels</title>
  </head>
  <body style="margin:0;padding:0;background:#F6F2EA;color:#333333;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F2EA;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E6DFD4;border-radius:14px;padding:32px;">
            <tr>
              <td style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.16em;color:#6B6B6B;text-transform:uppercase;padding-bottom:6px;">
                Feral Travels
              </td>
            </tr>
            <tr>
              <td style="font-size:22px;font-weight:700;color:#333333;padding-bottom:14px;">
                Your sign-in code
              </td>
            </tr>
            <tr>
              <td style="font-size:14px;line-height:1.55;color:#5C5C5C;padding-bottom:24px;">
                Enter this code on the sign-in screen to continue as <strong>${escapedTo}</strong>. The code is valid for <strong>10 minutes</strong>.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <div style="display:inline-block;background:#F6F2EA;border:2px solid #E6DFD4;border-radius:12px;padding:20px 32px;">
                  <span style="font-size:40px;font-weight:800;letter-spacing:0.18em;color:#333333;font-variant-numeric:tabular-nums;">${displayCode}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#5C5C5C;line-height:1.55;padding-bottom:16px;">
                Open the Feral Travels sign-in page and enter the code above. Do not share this code with anyone.
              </td>
            </tr>
            <tr>
              <td style="font-size:11px;color:#6B6B6B;line-height:1.5;border-top:1px solid #E6DFD4;padding-top:16px;">
                If you didn't request this code, you can safely ignore this email. Someone may have entered your address by mistake.
              </td>
            </tr>${domain ? `
            <!-- Origin-bound one-time code (WICG spec). Apple Mail, Gmail on
                 iOS, and Android use this line to auto-suggest pasting the code
                 into the correct website's input field. The format is:
                 @<domain> #<code>  -->
            <tr>
              <td style="font-size:0;line-height:0;color:#F6F2EA;max-height:0;overflow:hidden;mso-hide:all;" aria-hidden="true">
                @${domain} #${code}
              </td>
            </tr>` : ''}
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
