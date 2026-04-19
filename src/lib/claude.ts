import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { getTripFull } from '@/server/repos/trips';
import { logAnthropicUsage } from '@/server/repos/usage';

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
    { "action": "update_leg",    "leg_id": <number>, "data": { ... } },
    { "action": "add_route",     "leg_id": <number>, "data": { "label": "...", "description": "...", "distance_km": 120, "surface": "gravel"|"paved"|"mix", "links": [ { "type": "google_maps"|"gpx"|"wikiloc"|"komoot"|"gaia"|"other", "label": "View on Google Maps", "url": "https://..." } ] } },
    { "action": "update_route",  "route_id": <number>, "data": { "label": "...", "description": "...", "distance_km": 120, "surface": "gravel", "status": "option"|"selected"|"dismissed" } },
    { "action": "delete_route",  "route_id": <number> },
    { "action": "add_task",      "leg_id": <number|null>, "data": { "title": "...", "description": "...", "priority": "low"|"normal"|"high", "reference_url": "https://...", "reference_label": "Tirol pass status", "reference_phone": "+43..." } },
    { "action": "update_task",   "task_id": <number>, "data": { "status": "open"|"answered"|"dismissed", "answer": "..." } }
  ],
  "summary": "Brief description of what changed"
}

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

Important context defaults (override if the trip state says otherwise):
- Vehicle: Toyota Hilux with pop-top camper, two dogs
- Distances powered by Google Directions; OSRM is a fallback
- Overnight references: Park4Night, iOverlander
- Keep suggestions practical for a 4x4 overlander with camper`;

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
    text: `Current trip state:\n\`\`\`json\n${tripContext}\n\`\`\`\n\nUser request: ${userMessage || '(no text — see attached image(s))'}`,
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
