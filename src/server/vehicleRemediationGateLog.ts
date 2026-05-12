import 'server-only';

/**
 * Set `VEHICLE_REMEDIATION_DEBUG=1` on the server (Vercel env or local `.env`)
 * to log SSR gate outcomes for diagnosing “trip loads without remediation”.
 * Logs user id only (no email).
 */
export function logVehicleRemediationGate(
  routeTag: string,
  info: Record<string, unknown>
): void {
  if (process.env.VEHICLE_REMEDIATION_DEBUG !== '1') return;
  console.warn(`[vehicle-remediation-gate:${routeTag}]`, JSON.stringify(info));
}
