import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { getTripFull } from '@/server/repos/trips';
import { logAnthropicUsage } from '@/server/repos/usage';
import { getVehicleForUser, getDefaultVehicleForUser, type VehicleApi } from '@/server/repos/vehicles';
import {
  findOvernightSpots,
  bandSpotsByDriveTime,
  pickBestPerBand,
  type BandedSpot,
} from '@/server/overnight/findOvernightSpots';
import type { TripWithLegs } from '@/types/trip';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are Penny, the trip planner AI for an overlanding trip.

You have the full current trip state as context (sent in the user message as JSON), including each leg's existing routes (route options with links) and tasks.

Style rules — follow strictly:
- Be concise. Default to 1-3 short sentences. No preamble, no recap of what the user said, no closing pleasantries.
- No bullet lists unless the user explicitly asks for one.
- If the user is just chatting or asking a question, answer in plain prose only — no JSON.
- If you make changes, give a one-sentence confirmation of what changed and why, then the JSON block. Nothing else.

When trip data should be modified, append a JSON block wrapped in \`\`\`json ... \`\`\` with this shape:
{
  "changes": [
    { "action": "add_leg",       "data": { "title": "Girona → Nice", "start_name": "Girona", "end_name": "Nice", "start_lat": 41.98, "start_lng": 2.82, "end_lat": 43.71, "end_lng": 7.26, "distance_km": 540, "drive_time_minutes": 360, "terrain": "highway", "status": "planning" } },
    { "action": "delete_leg",    "leg_id": <number> },
    { "action": "update_leg",    "leg_id": <number>, "data": { ... } },
    { "action": "add_route",     "leg_id": <number>, "data": { "label": "...", "description": "...", "distance_km": 120, "surface": "gravel"|"paved"|"mix", "end_lat": <number?>, "end_lng": <number?>, "end_name": "...", "end_source": "ioverlander"|"park4night"|"google_places"|"manual", "end_source_url": "https://...", "drive_time_minutes": <number?>, "links": [ { "type": "google_maps"|"gpx"|"wikiloc"|"komoot"|"gaia"|"park4night"|"ioverlander"|"dog_park"|"other", "label": "View on Google Maps", "url": "https://..." } ] } },
    { "action": "update_route",  "route_id": <number>, "data": { "label": "...", "description": "...", "distance_km": 120, "surface": "gravel", "status": "option"|"selected"|"dismissed" } },
    { "action": "delete_route",  "route_id": <number> },
    { "action": "add_task",      "leg_id": <number|null>, "data": { "title": "...", "description": "...", "priority": "low"|"normal"|"high", "reference_url": "https://...", "reference_label": "Tirol pass status", "reference_phone": "+43..." } },
    { "action": "update_task",   "task_id": <number>, "data": { "status": "open"|"answered"|"dismissed", "answer": "..." } }
  ],
  "summary": "Brief description of what changed"
}

Building a plan from scratch (leg rules — CRITICAL):
- If the user asks for a route or plan and the trip has NO legs yet, you MUST emit one \`add_leg\` action per driving day to create the plan. Never claim to have "created a leg" without emitting \`add_leg\` — without it nothing is saved.
- For each \`add_leg\`, fill in as many fields as you reasonably can: title, start_name/end_name, start_lat/lng, end_lat/lng, distance_km, drive_time_minutes (respect the vehicle's max_drive_hours_per_day), terrain, dates (when known).
- Pace legs at the vehicle's max_drive_hours_per_day (default 6h if unknown). Don't exceed it without explicit user permission.
- If the user gives only a destination (no origin) and the trip has no legs, ASK for the starting point in plain prose — do not emit add_leg actions.

For update_leg, only include the fields that changed. Valid fields:
- title, label, start_name, end_name, dates, distance_km, drive_time_minutes
- terrain, overnight, status, color, notes (array of strings)
- start_lat, start_lng, end_lat, end_lng
- costs (array of {item, estimate, is_total})

Routes & tasks rules — follow strictly:
- When the user (or you) describes multi-option routes (e.g. "Route A / B / C"), emit them as separate \`add_route\` actions. DO NOT bury route options inside the leg's \`notes\` array. Notes should only contain general observations — never things the user would want to click.
- For each route, attach \`links[]\` with the most useful canonical URLs you know of (Google Maps directions URL, Wikiloc track, Komoot tour, Gaia track, official trail page). If you don't have a canonical URL, leave \`links\` empty — the user can paste one in the UI.
- For \`type: "google_maps"\` links, ALWAYS use the Maps URLs API directions format with \`dir_action=navigate\`, e.g. \`https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG&travelmode=driving&dir_action=navigate\`. Do NOT use \`maps/place\` preview URLs or \`maps.app.goo.gl\` short links — they open a preview, not turn-by-turn nav.
- Whenever the trip plan calls for a verification step (e.g. "check the pass is open", "confirm campsite is bookable", "verify ferry schedule"), emit an \`add_task\` instead of putting it in \`notes\`. Set \`reference_url\` (and \`reference_phone\` when available) to the official source. Default \`priority\` to "normal", use "high" for blockers (closed pass, expiring booking).
- Don't recreate routes or tasks that already exist in the current trip state — update them instead.

If the user attaches a screenshot, treat it as supporting context — describe nothing about it unless it directly affects the change you're proposing.

Vehicle constraints (when present):
- A <vehicle_constraints>...</vehicle_constraints> block in the user message contains the trip's selected vehicle. Treat its limits as hard constraints unless the user explicitly overrides them.
- Never schedule a leg that exceeds max_drive_hours_per_day without an explicit "I'm fine driving longer today" note from the user.
- If height_m > 2.0, avoid clearance-blocking routes (low bridges, narrow scrub-tight tracks); prefer paved or wide gravel.
- Schedule freshwater refill / blackwater dump tasks at roughly the freshwater_refill_days / blackwater_dump_days interval.
- When proposing overnight stops, derive drive-time bands from max_drive_hours_per_day (e.g. ~50%, ~85%, and 100% of daily max).

Overnight spot rules (when planning a leg's overnight stop):
- A <overnight_candidates leg_id="N">...</overnight_candidates> block in the user message lists pre-fetched free overnight spots for that leg, already grouped into ~3 drive-time bands (short / medium / long). Strongly prefer these — they're real, free, current.
- For each leg with candidates, emit up to 3 \`add_route\` actions — one per band — and set:
    - \`label\`: "<band>h: <spot name>" (e.g. "3h: Aire de Repos Saint-Affrique")
    - \`end_lat\`, \`end_lng\`, \`end_name\`: copy from the candidate
    - \`end_source\`: the candidate's \`source\` field
    - \`end_source_url\`: the candidate's \`url\` field
    - \`drive_time_minutes\`: the candidate's \`driveTimeMinutes\`
    - \`description\`: 1 sentence about why this spot is appropriate (proximity to next leg, scenery, vehicle fit)
    - \`links\`: include a Google Maps nav link to (end_lat, end_lng) and a link to the source page
- After emitting routes, emit one \`add_task\` titled exactly "Pick tonight's stop" on the same leg with priority "normal" — when the user picks a route in the UI we'll auto-mark it answered.
- Never mark a route \`status: "selected"\` yourself — the user picks. Default \`status\` to "option".
- If candidates are empty for a leg the user is asking about, say so honestly in 1 sentence and suggest they tap "Find a spot near here" once they've started driving.

Important context defaults (override if the trip state or vehicle constraints say otherwise):
- Distances powered by Google Directions; OSRM is a fallback
- Overnight references: Park4Night, iOverlander, dog parks with parking lots
- Keep suggestions practical for the trip's selected vehicle`;

interface InputImage {
  dataUrl: string;
  mediaType: string;
}

export async function replan(
  userMessage: string,
  tripId: number,
  images: InputImage[] = [],
  userId?: string
) {
  const trip = await getTripFull(tripId);
  if (!trip) throw new Error('Trip not found');

  const tripContext = JSON.stringify(trip, null, 2);

  // Pull the trip's vehicle (or the user's default) so Penny can plan within
  // real constraints — drive limits, fuel range, clearance, water cadence.
  let vehicle: VehicleApi | null = null;
  if (userId) {
    if (trip.vehicle_id != null) {
      vehicle = await getVehicleForUser(userId, trip.vehicle_id).catch(() => null);
    }
    if (!vehicle) {
      vehicle = await getDefaultVehicleForUser(userId).catch(() => null);
    }
  }
  const vehicleBlock = vehicle ? renderVehicleConstraints(vehicle) : '';

  // Pre-fetch overnight candidates for legs that don't yet have a selected
  // route, so Penny can recommend real free spots without the user having to
  // ask separately. Capped to 3 legs to keep upstream API cost bounded; the
  // overnight cache makes repeat replans free anyway.
  const overnightBlock = await renderOvernightCandidates(trip).catch((e) => {
    console.warn('[claude] overnight pre-fetch failed', e);
    return '';
  });

  const content: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];

  for (const img of images) {
    const match = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) continue;
    const mediaType = (img.mediaType || match[1]) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    const data = match[2];
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    });
  }

  content.push({
    type: 'text',
    text: `Current trip state:\n\`\`\`json\n${tripContext}\n\`\`\`\n${vehicleBlock}${overnightBlock}\nUser request: ${userMessage || '(no text — see attached image(s))'}`,
  });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
  } catch (err: any) {
    if (userId) {
      await logAnthropicUsage({
        userId,
        tripId,
        model: MODEL,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        errorMessage: String(err?.message ?? err).slice(0, 500),
      }).catch(() => {});
    }
    throw err;
  }

  if (userId) {
    await logAnthropicUsage({
      userId,
      tripId,
      model: MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      success: true,
    }).catch((e) => console.warn('logAnthropicUsage failed:', e));
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  let changes: any = null;
  let conversationalResponse = text;

  if (jsonMatch) {
    try {
      changes = JSON.parse(jsonMatch[1]);
      conversationalResponse = text.replace(/```json\s*[\s\S]*?\s*```/, '').trim();
    } catch (e) {
      console.error('Failed to parse Claude JSON:', e);
    }
  }

  return {
    response: conversationalResponse,
    changes,
  };
}

// How many legs we'll pre-fetch overnight candidates for in a single replan.
// 3 keeps the worst case bounded at ~3 sources × 3 legs = ~9 upstream calls,
// and the overnight cache means subsequent replans for the same area are free.
const OVERNIGHT_PREFETCH_MAX_LEGS = 3;

async function renderOvernightCandidates(trip: TripWithLegs): Promise<string> {
  // Only consider legs that need help: have a start coord, no human-selected
  // route yet, and aren't marked confirmed/anchored (those stops are decided).
  const candidatesNeeded = trip.legs
    .filter((l) => l.start_lat != null && l.start_lng != null)
    .filter((l) => !l.routes.some((r) => r.status === 'selected'))
    .filter((l) => l.status !== 'confirmed' && l.status !== 'anchored')
    .slice(0, OVERNIGHT_PREFETCH_MAX_LEGS);

  if (candidatesNeeded.length === 0) return '';

  const blocks: string[] = [];
  for (const leg of candidatesNeeded) {
    try {
      const spots = await findOvernightSpots({
        lat: leg.start_lat as number,
        lng: leg.start_lng as number,
        radiusKm: 420,
        perSourceLimit: 25,
        freeOnly: true,
      });
      const banded = bandSpotsByDriveTime(spots, leg.start_lat as number, leg.start_lng as number);
      const best = pickBestPerBand(banded);
      if (best.length === 0) continue;
      blocks.push(renderCandidatesXml(leg.id, leg.title || leg.label || `Leg ${leg.id}`, best));
    } catch (e) {
      console.warn(`[claude] overnight pre-fetch failed for leg ${leg.id}`, e);
    }
  }

  if (blocks.length === 0) return '';
  return `\n${blocks.join('\n')}\n`;
}

function renderCandidatesXml(legId: number, legLabel: string, candidates: BandedSpot[]): string {
  const items = candidates
    .map((c) => {
      const safeName = c.name.replace(/[<>&]/g, ' ').slice(0, 80);
      return [
        `  <candidate band="${c.band}" driveTimeMinutes="${c.driveTimeMinutes}">`,
        `    name: ${safeName}`,
        `    source: ${c.source}`,
        `    category: ${c.category}`,
        `    lat: ${c.lat}`,
        `    lng: ${c.lng}`,
        c.sourceUrl ? `    url: ${c.sourceUrl}` : null,
        c.description
          ? `    notes: ${c.description.replace(/\s+/g, ' ').slice(0, 140)}`
          : null,
        `  </candidate>`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  return `<overnight_candidates leg_id="${legId}" leg="${legLabel.replace(/"/g, "'")}">\n${items}\n</overnight_candidates>`;
}

function renderVehicleConstraints(v: VehicleApi): string {
  const lines: string[] = [];
  lines.push(`name: ${v.name}`);
  if (v.vehicle_type) lines.push(`type: ${v.vehicle_type}`);
  if (v.height_cm != null) lines.push(`height_m: ${(v.height_cm / 100).toFixed(2)}`);
  if (v.length_m != null) lines.push(`length_m: ${v.length_m}`);
  if (v.weight_kg != null) lines.push(`weight_kg: ${v.weight_kg}`);
  if (v.fuel_economy_kmpl != null) lines.push(`fuel_economy_kmpl: ${v.fuel_economy_kmpl}`);
  if (v.fuel_tank_l != null) lines.push(`fuel_tank_l: ${v.fuel_tank_l}`);
  if (v.fuel_economy_kmpl != null && v.fuel_tank_l != null) {
    lines.push(`range_km: ${Math.round(v.fuel_economy_kmpl * v.fuel_tank_l)}`);
  }
  if (v.max_drive_hours_per_day != null)
    lines.push(`max_drive_hours_per_day: ${v.max_drive_hours_per_day}`);
  if (v.max_drive_hours_per_week != null)
    lines.push(`max_drive_hours_per_week: ${v.max_drive_hours_per_week}`);
  if (v.max_consecutive_drive_days != null)
    lines.push(`max_consecutive_drive_days: ${v.max_consecutive_drive_days}`);
  if (v.water_refill_days != null) lines.push(`freshwater_refill_days: ${v.water_refill_days}`);
  if (v.blackwater_refill_days != null)
    lines.push(`blackwater_dump_days: ${v.blackwater_refill_days}`);
  if (v.notes) lines.push(`notes: ${v.notes.replace(/\n+/g, ' ')}`);
  return `\n<vehicle_constraints>\n${lines.join('\n')}\n</vehicle_constraints>\n`;
}
