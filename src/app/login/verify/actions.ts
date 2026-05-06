'use server';

import { redirect } from 'next/navigation';
import { signIn } from '@/server/auth';
import { sendOtpCode } from '@/server/auth/otp';

/**
 * Validate the submitted OTP code and sign the user in.
 * Called by the client-side VerifyForm via form action.
 */
export async function verifyOtpAction(formData: FormData) {
  const email = String(formData.get('email') || '').trim();
  const code = String(formData.get('code') || '').trim();
  const callbackUrl = String(formData.get('callbackUrl') || '/trips');

  try {
    await signIn('email-otp', { email, code, redirectTo: callbackUrl });
  } catch (err) {
    // Auth.js throws a NEXT_REDIRECT "error" on a successful sign-in to
    // trigger the navigation — we must re-throw it.
    if (
      err &&
      typeof err === 'object' &&
      'digest' in err &&
      String((err as { digest?: string }).digest).startsWith('NEXT_REDIRECT')
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[verify] OTP sign-in failed:', message);
    redirect(
      `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&error=InvalidCode`
    );
  }
}

/**
 * Resend an OTP code to the given email address.
 * Called by the "Resend code" button on the verify page.
 */
export async function resendOtpAction(formData: FormData) {
  const email = String(formData.get('email') || '').trim();
  const callbackUrl = String(formData.get('callbackUrl') || '/trips');

  try {
    await sendOtpCode(email);
    redirect(
      `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&resent=1`
    );
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'digest' in err &&
      String((err as { digest?: string }).digest).startsWith('NEXT_REDIRECT')
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = message === 'RateLimited' ? 'RateLimited' : 'EmailSendFailed';
    redirect(
      `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&error=${code}`
    );
  }
}
