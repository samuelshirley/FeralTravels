import 'server-only';
import type { LegWithDetails } from '@/types/trip';
import type { ConstraintCheckResult } from './engine';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE_BASE = `margin:0;padding:0;background:#F6F2EA;color:#333333;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;`;
const STYLE_CARD = `max-width:540px;background:#FFFFFF;border:1px solid #E6DFD4;border-radius:14px;padding:32px;`;
const STYLE_HEADING = `font-size:22px;font-weight:700;color:#333333;padding-bottom:14px;`;
const STYLE_BODY = `font-size:14px;line-height:1.55;color:#5C5C5C;padding-bottom:16px;`;
const STYLE_BTN = `display:inline-block;background:#4A8B7A;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;`;
const STYLE_WARN = `background:#FFF3E0;border:1px solid #FFB74D;border-radius:8px;padding:12px 16px;font-size:13px;color:#5C3A00;margin-bottom:16px;`;

function wrapEmail(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/><title>${escapeHtml(title)}</title></head>
<body style="${STYLE_BASE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F2EA;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${STYLE_CARD}">
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.16em;color:#6B6B6B;text-transform:uppercase;padding-bottom:6px;">Feral Travels</td></tr>
${body}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── On-track morning email ─────────────────────────────────────────────────

export interface MorningEmailData {
  dayNumber: number;
  origin: string;
  destination: string;
  distanceKm: number;
  driveTimeMinutes: number;
  navLink: string;
  stops: { name: string; type: string }[];
  constraintWarnings: ConstraintCheckResult[];
}

export function renderMorningEmail(data: MorningEmailData): { subject: string; html: string } {
  const hours = Math.floor(data.driveTimeMinutes / 60);
  const mins = data.driveTimeMinutes % 60;
  const timeStr = mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;

  const warnings = data.constraintWarnings
    .filter((c) => c.status === 'at_risk' || c.status === 'fail')
    .map((c) => {
      const leaveBy = c.leave_by
        ? `Leave by ${new Date(c.leave_by).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
        : '';
      return `<div style="${STYLE_WARN}">${leaveBy ? `<strong>${escapeHtml(leaveBy)}</strong> — ` : ''}${escapeHtml(c.detail)} (${escapeHtml(c.constraint.note ?? '')})</div>`;
    })
    .join('');

  const stopsList = data.stops.length > 0
    ? `<tr><td style="${STYLE_BODY}"><strong>Planned stops:</strong> ${data.stops.map((s) => `${escapeHtml(s.name)} (${escapeHtml(s.type)})`).join(' · ')}</td></tr>`
    : '';

  const body = `
<tr><td style="${STYLE_HEADING}">Day ${data.dayNumber}: ${escapeHtml(data.origin)} → ${escapeHtml(data.destination)}</td></tr>
<tr><td style="${STYLE_BODY}">${escapeHtml(String(Math.round(data.distanceKm)))} km · ${escapeHtml(timeStr)} driving</td></tr>
${warnings ? `<tr><td>${warnings}</td></tr>` : ''}
${stopsList}
<tr><td style="padding-bottom:24px;"><a href="${escapeHtml(data.navLink)}" style="${STYLE_BTN}">Open in Google Maps →</a></td></tr>
<tr><td style="font-size:12px;color:#999;padding-top:16px;">This email was sent by Penny based on your trip plan. Reply to this email if you have questions.</td></tr>`;

  return {
    subject: `Day ${data.dayNumber}: ${data.origin} → ${data.destination} — ${Math.round(data.distanceKm)} km`,
    html: wrapEmail(`Day ${data.dayNumber}`, body),
  };
}

// ── Rest day email ─────────────────────────────────────────────────────────

export interface RestDayEmailData {
  dayNumber: number;
  location: string;
  tomorrowDestination?: string;
  tomorrowDistanceKm?: number;
  tomorrowDriveTimeMinutes?: number;
}

export function renderRestDayEmail(data: RestDayEmailData): { subject: string; html: string } {
  const tomorrowPreview = data.tomorrowDestination
    ? (() => {
        const h = Math.floor((data.tomorrowDriveTimeMinutes ?? 0) / 60);
        const m = (data.tomorrowDriveTimeMinutes ?? 0) % 60;
        const t = m > 0 ? `${h}h ${m}min` : `${h}h`;
        return `<tr><td style="${STYLE_BODY}"><strong>Tomorrow:</strong> Drive to ${escapeHtml(data.tomorrowDestination)} (${Math.round(data.tomorrowDistanceKm ?? 0)} km, ~${t})</td></tr>`;
      })()
    : '';

  const body = `
<tr><td style="${STYLE_HEADING}">Rest day in ${escapeHtml(data.location)}</td></tr>
<tr><td style="${STYLE_BODY}">No driving today — enjoy your time in ${escapeHtml(data.location)}.</td></tr>
${tomorrowPreview}
<tr><td style="font-size:12px;color:#999;padding-top:16px;">This email was sent by Penny based on your trip plan.</td></tr>`;

  return {
    subject: `Rest day in ${data.location}`,
    html: wrapEmail(`Rest day`, body),
  };
}

// ── Off-route email ────────────────────────────────────────────────────────

export interface OffRouteEmailData {
  actualLocation: string;
  expectedLocation: string;
  tripId: string;
  baseUrl: string;
}

export function renderOffRouteEmail(data: OffRouteEmailData): { subject: string; html: string } {
  const replanLink = `${data.baseUrl}/trips/${data.tripId}?replan=true`;

  const body = `
<tr><td style="${STYLE_HEADING}">Looks like you've gone off-route</td></tr>
<tr><td style="${STYLE_BODY}">We expected you near <strong>${escapeHtml(data.expectedLocation)}</strong> but it looks like you're closer to <strong>${escapeHtml(data.actualLocation)}</strong>.</td></tr>
<tr><td style="${STYLE_BODY}">Want Penny to adjust your remaining plan from where you are?</td></tr>
<tr><td style="padding-bottom:24px;"><a href="${escapeHtml(replanLink)}" style="${STYLE_BTN}">Adjust my trip →</a></td></tr>
<tr><td style="font-size:12px;color:#999;padding-top:16px;">This email was sent by Penny because your GPS position is far from your planned route.</td></tr>`;

  return {
    subject: `You're off-route — want Penny to adjust your plan?`,
    html: wrapEmail('Off-route', body),
  };
}

// ── Stale position email ───────────────────────────────────────────────────

export interface StalePositionEmailData {
  tripName: string;
}

export function renderStalePositionEmail(data: StalePositionEmailData): { subject: string; html: string } {
  const body = `
<tr><td style="${STYLE_HEADING}">Your trip plan for today</td></tr>
<tr><td style="${STYLE_BODY}">We couldn't get a recent GPS fix for your trip "<strong>${escapeHtml(data.tripName)}</strong>", so we couldn't update your plan automatically. Open the app to share your location and get an updated plan.</td></tr>
<tr><td style="font-size:12px;color:#999;padding-top:16px;">This email was sent by Penny.</td></tr>`;

  return {
    subject: `${data.tripName} — open the app to update your plan`,
    html: wrapEmail('Trip update', body),
  };
}

// ── Google Maps nav link builder ───────────────────────────────────────────

export function buildGoogleMapsNavLink(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  waypoints?: { lat: number; lng: number }[],
): string {
  const params = new URLSearchParams({
    api: '1',
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: 'driving',
  });
  if (waypoints && waypoints.length > 0) {
    params.set('waypoints', waypoints.map((w) => `${w.lat},${w.lng}`).join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
