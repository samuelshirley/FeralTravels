import 'server-only';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { trips, legs } from '@/server/db/schema';
import {
  getActiveTrips,
  autoTransitionTripStatuses,
  getTripFull,
} from '@/server/repos/trips';
import { logUsageEvent } from '@/server/repos/usage';
import {
  deterministicReplan,
  classifyDeviation,
  guessCurrentLeg,
} from '@/lib/replan/engine';
import {
  renderMorningEmail,
  renderRestDayEmail,
  renderOffRouteEmail,
  renderStalePositionEmail,
  buildGoogleMapsNavLink,
} from '@/lib/replan/emails';
import type { ReplanPosition } from '@/lib/replan/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min for Vercel Pro

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Temporary gate: only run cron for this user to limit Vercel usage.
 * Remove this (and the onlyUserId filtering below) when ready to open up.
 */
const ALLOWED_CRON_EMAIL = 'samuelashirley@gmail.com';

/**
 * Check if it's approximately 2am at the given GPS position.
 * Uses a ±30 minute window. Returns false if position is missing.
 */
function isApprox2amLocal(lat: number, lng: number): boolean {
  // Rough timezone offset from longitude: 1 hour per 15 degrees
  const tzOffsetHours = Math.round(lng / 15);
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const localMinutesSinceMidnight = ((utcHour + tzOffsetHours + 24) % 24) * 60 + utcMinute;
  // 2am = 120 minutes since midnight. ±30min window = 90-150.
  return localMinutesSinceMidnight >= 90 && localMinutesSinceMidnight <= 150;
}

/**
 * Send an email via Resend. Wraps the existing Resend integration.
 */
async function sendEmail(to: string, subject: string, html: string) {
  const key = process.env.AUTH_RESEND_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!key || !from) {
    console.warn('[nightly-replan] Resend not configured, skipping email');
    return;
  }
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(key);
    await resend.emails.send({ from, to, subject, html });
  } catch (err) {
    console.error('[nightly-replan] Failed to send email:', err);
  }
}

/**
 * Look up user email from userId.
 */
async function getUserEmail(userId: string): Promise<string | null> {
  const { users } = await import('@/server/db/schema');
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Reverse geocode a lat/lng to a city name (approximate).
 * Falls back to "lat, lng" if geocoding isn't available.
 */
function formatPosition(lat: number, lng: number): string {
  return `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
}

export async function POST(req: NextRequest) {
  // Verify cron secret
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startTime = Date.now();
  let activeCount = 0;
  let replannedCount = 0;
  let offRouteCount = 0;
  let skippedCount = 0;

  try {
    // Look up the allowed user's ID to scope all cron work
    const { users } = await import('@/server/db/schema');
    const allowedRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ALLOWED_CRON_EMAIL))
      .limit(1);
    const onlyUserId = allowedRows[0]?.id;

    if (!onlyUserId) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Allowed cron user (${ALLOWED_CRON_EMAIL}) not found in DB`,
      });
    }

    // Step 1: Auto-transition trip statuses (draft→active, active→completed)
    const transitions = await autoTransitionTripStatuses(onlyUserId);

    // Step 2: Get all active trips (filtered to allowed user only)
    const activeTrips = await getActiveTrips(onlyUserId);
    activeCount = activeTrips.length;

    // Step 3: Process each active trip
    const baseUrl = process.env.NEXTAUTH_URL || 'https://app.feraltravels.com';

    for (const tripRow of activeTrips) {
      try {
        // Check if we have GPS data
        if (tripRow.lastKnownLat == null || tripRow.lastKnownLng == null) {
          skippedCount++;
          continue;
        }

        // Check if it's ~2am at the user's position
        if (!isApprox2amLocal(tripRow.lastKnownLat, tripRow.lastKnownLng)) {
          continue;
        }

        // Check GPS staleness (>24h = stale)
        const posAge = tripRow.positionUpdatedAt
          ? Date.now() - tripRow.positionUpdatedAt.getTime()
          : Infinity;
        const isStale = posAge > 24 * 60 * 60 * 1000;

        const email = await getUserEmail(tripRow.userId);
        if (!email) continue;

        if (isStale) {
          // Send generic stale-position email
          const { subject, html } = renderStalePositionEmail({ tripName: tripRow.name });
          await sendEmail(email, subject, html);
          skippedCount++;
          continue;
        }

        // Load full trip data
        const trip = await getTripFull(tripRow.id);
        if (!trip || trip.legs.length === 0) continue;

        const position: ReplanPosition = {
          lat: tripRow.lastKnownLat,
          lng: tripRow.lastKnownLng,
        };

        // Determine current leg and deviation
        const { legIndex, deviationKm } = guessCurrentLeg(position, trip.legs);
        const currentLeg = trip.legs[legIndex];
        const isRestDay = currentLeg?.leg_type === 'rest';
        const band = classifyDeviation(deviationKm, isRestDay);

        if (band === 'off_route') {
          // Level 2: off-route notification (no automatic replan)
          const expectedLocation = currentLeg?.end_name ?? formatPosition(
            currentLeg?.end_lat ?? 0,
            currentLeg?.end_lng ?? 0,
          );
          const { subject, html } = renderOffRouteEmail({
            actualLocation: formatPosition(position.lat, position.lng),
            expectedLocation,
            tripId: trip.id,
            baseUrl,
          });
          await sendEmail(email, subject, html);
          offRouteCount++;
          continue;
        }

        // Level 1: deterministic replan (on_track or minor_drift)
        const replanResult = await deterministicReplan(position, trip);

        // Persist updated leg drive times
        for (const updated of replanResult.updatedLegs) {
          await db
            .update(legs)
            .set({
              driveTimeMinutes: updated.driveTimeMinutes,
              distanceKm: updated.distanceKm,
              updatedAt: new Date(),
            })
            .where(eq(legs.id, updated.legId));
        }

        // Determine today's leg for email
        const todayLeg = trip.legs[legIndex];
        if (!todayLeg) continue;

        if (todayLeg.leg_type === 'rest') {
          // Rest day email
          const tomorrowLeg = trip.legs[legIndex + 1];
          const { subject, html } = renderRestDayEmail({
            dayNumber: legIndex + 1,
            location: todayLeg.end_name ?? todayLeg.start_name ?? 'your location',
            tomorrowDestination: tomorrowLeg?.end_name ?? undefined,
            tomorrowDistanceKm: tomorrowLeg?.distance_km ?? undefined,
            tomorrowDriveTimeMinutes: tomorrowLeg?.drive_time_minutes ?? undefined,
          });
          await sendEmail(email, subject, html);
        } else {
          // Driving day email
          const origin = todayLeg.start_name ?? formatPosition(position.lat, position.lng);
          const destination = todayLeg.end_name ?? 'destination';
          const updated = replanResult.updatedLegs.find((u) => u.legId === todayLeg.id);
          const distanceKm = updated?.distanceKm ?? todayLeg.distance_km ?? 0;
          const driveTimeMinutes = updated?.driveTimeMinutes ?? todayLeg.drive_time_minutes ?? 0;

          // Build nav link
          const navLink = todayLeg.end_lat != null && todayLeg.end_lng != null
            ? buildGoogleMapsNavLink(
                position,
                { lat: todayLeg.end_lat, lng: todayLeg.end_lng },
                todayLeg.stops
                  .filter((s) => s.status === 'selected' && s.lat != null && s.lng != null)
                  .map((s) => ({ lat: s.lat!, lng: s.lng! })),
              )
            : '';

          const { subject, html } = renderMorningEmail({
            dayNumber: legIndex + 1,
            origin,
            destination,
            distanceKm,
            driveTimeMinutes,
            navLink,
            stops: todayLeg.stops
              .filter((s) => s.status === 'selected')
              .map((s) => ({ name: s.name, type: s.stop_type })),
            constraintWarnings: replanResult.constraintResults,
          });
          await sendEmail(email, subject, html);
        }

        replannedCount++;
      } catch (err) {
        console.error(`[nightly-replan] Error processing trip ${tripRow.id}:`, err);
      }
    }

    // Log usage event
    await logUsageEvent({
      userId: null,
      tripId: null,
      provider: 'cron:nightly_replan',
      requests: 1,
      success: true,
      errorMessage: null,
    });

    const durationMs = Date.now() - startTime;
    return Response.json({
      ok: true,
      duration_ms: durationMs,
      transitions,
      active_trips: activeCount,
      replanned: replannedCount,
      off_route: offRouteCount,
      skipped: skippedCount,
    });
  } catch (err) {
    console.error('[nightly-replan] Fatal error:', err);
    return Response.json(
      { error: 'Internal server error', detail: String(err) },
      { status: 500 },
    );
  }
}
