import 'server-only';

/**
 * HTML for the OTP code sign-in email. Shows a large 6-digit code instead of
 * a magic link — the user types the code on the /login/verify screen.
 *
 * NOCTURNE, WITH EMAIL'S CONSTRAINTS. Everything here is a literal hex value
 * and an inline style: mail clients strip `<style>` blocks, CSS custom
 * properties and external stylesheets, so `--tp-*` cannot reach an inbox. Keep
 * these in step with `src/app/globals.css` by hand — the palette below is the
 * one place in the codebase where the tokens are duplicated ON PURPOSE.
 *
 * Two things carry the dark ground safely:
 *   - `color-scheme` / `supported-color-schemes` in the head, which stop Apple
 *     Mail and iOS from "helpfully" inverting an already-dark email.
 *   - a background colour on the body AND the outer table, because several
 *     clients honour only one of the two.
 *
 * The code renders as "123 456" for legibility. That is deliberate and
 * asserted by `e2e/login-otp.spec.ts` — the BARE run iOS scans for lives in
 * the subject line, the text part, and the origin-bound line below.
 */

/* Nocturne, duplicated as literals — see the note above. */
const BG = '#161826';
const SURFACE = '#232532';
const BORDER = '#3f424d';
const HAIRLINE = '#292b31';
const TEXT = '#e9e9ed';
const MUTED = '#b2b6ca';
const SUBTLE = '#75798c';
const ACCENT_300 = '#d2cefd';
const ACCENT_900 = '#2b2741';

/**
 * Inter first for the few clients that have it, then the system stack every
 * other client will actually use. A webfont `@import` would be stripped, and
 * loading one from an email is a tracking vector besides.
 */
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

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
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>Sign in to Feral Travels</title>
  </head>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:${FONT};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:32px;">
            <tr>
              <td style="font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:0.16em;color:${ACCENT_300};text-transform:uppercase;padding-bottom:6px;">
                Feral Travels
              </td>
            </tr>
            <tr>
              <td style="font-size:24px;font-weight:500;color:${TEXT};padding-bottom:14px;">
                Your sign-in code
              </td>
            </tr>
            <tr>
              <td style="font-size:14px;line-height:1.55;color:${MUTED};padding-bottom:24px;">
                Enter this code on the sign-in screen to continue as <strong style="font-weight:500;color:${TEXT};">${escapedTo}</strong>. The code is valid for <strong style="font-weight:500;color:${TEXT};">10 minutes</strong>.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <div style="display:inline-block;background:${ACCENT_900};border:1px solid ${BORDER};border-radius:12px;padding:20px 32px;">
                  <span style="font-size:40px;font-weight:600;letter-spacing:0.18em;color:${TEXT};font-variant-numeric:tabular-nums;">${displayCode}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="font-size:13px;color:${MUTED};line-height:1.55;padding-bottom:16px;">
                Open the Feral Travels sign-in page and enter the code above. Do not share this code with anyone.
              </td>
            </tr>
            <tr>
              <td style="font-size:11px;color:${SUBTLE};line-height:1.5;border-top:1px solid ${HAIRLINE};padding-top:16px;">
                If you didn't request this code, you can safely ignore this email. Someone may have entered your address by mistake.
              </td>
            </tr>${domain ? `
            <!-- Origin-bound one-time code (WICG spec). Apple Mail, Gmail on
                 iOS, and Android use this line to auto-suggest pasting the code
                 into the correct website's input field. The format is:
                 @<domain> #<code>

                 The colour MUST match the page background — that is what hides
                 it. It moved with the palette; a stale value here prints the
                 raw code at the bottom of the email. -->
            <tr>
              <td style="font-size:0;line-height:0;color:${BG};max-height:0;overflow:hidden;mso-hide:all;" aria-hidden="true">
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
