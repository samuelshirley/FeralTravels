'use server';

import { redirect } from 'next/navigation';
import { OtpRateLimitError, retryAfterSeconds, sendOtpCode, signInWithOtp } from '@/server/auth/otp';

/**
 * Validate the submitted OTP code and sign the user in.
 * Called by the client-side VerifyForm via form action.
 *
 * We don't use Auth.js's `signIn('credentials', ...)` because the Credentials
 * provider does not support database sessions. Instead, `signInWithOtp` handles
 * code verification, user lookup/creation, session creation, and cookie setting
 * all in one shot.
 */
export async function verifyOtpAction(formData: FormData) {
  const email = String(formData.get('email') || '').trim();
  const code = String(formData.get('code') || '').trim();
  const callbackUrl = String(formData.get('callbackUrl') || '/trips');

  const userId = await signInWithOtp(email, code);

  if (!userId) {
    redirect(
      `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&error=InvalidCode`
    );
  }

  redirect(callbackUrl);
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
    // The wait is carried in the URL so the page can render an accurate
    // countdown. Hard-coding "60 seconds" in the copy was the original sin
    // here: it was wrong the moment the ladder had more than one rung, and
    // it was wrong even before that for anyone who had already waited 55.
    if (err instanceof OtpRateLimitError) {
      redirect(
        `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&error=RateLimited&retryAfter=${retryAfterSeconds(err.retryAfterMs)}`
      );
    }
    redirect(
      `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&error=EmailSendFailed`
    );
  }
}
