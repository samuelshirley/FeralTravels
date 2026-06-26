import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { RANGE_ESTIMATE_MODEL } from '@/lib/models';
import { FUEL_STOP_SPACING_KM_MIN, FUEL_STOP_SPACING_KM_MAX } from '@/lib/vehicleProfile';
import { logAnthropicUsageWithFallback } from '@/server/repos/usage';

/**
 * Onboarding "I don't know my comfortable range" helper.
 *
 * When the driver can't give a number, they instead say what they DO know —
 * their vehicle (make/model/year) or tank size + rough fuel economy. This turns
 * that free text into a single CONSERVATIVE comfortable-range estimate (km),
 * which the onboarding flow then shows back for the driver to confirm or edit.
 * It is **never persisted without confirmation** (lockdown: the LLM proposes, it
 * does not author the stored safety number).
 *
 * Mirrors `parseStartDate.ts`: forced tool (the schema is the contract, no prose
 * to scrape) + strict server-side re-validation of the returned number. Returns
 * `{ km: null }` whenever there isn't enough signal, the API errors/times out,
 * or no key is configured — the caller then re-asks or lets the driver type a
 * number directly. Never throws.
 *
 * NOTE: keep the SDK import here, never in `@/lib/vehicleProfile` (that stays
 * pure + client-safe — it's imported by client components).
 */

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const RANGE_ESTIMATE_TIMEOUT_MS = 6000;

// Forced tool — the model can only hand back this shape. We STILL re-validate
// `comfortable_km` server-side (the schema can't enforce the km band or that the
// estimate is conservative).
const RANGE_TOOL: Anthropic.Tool = {
  name: 'record_comfortable_range',
  description:
    'Record a conservative estimate of the driver’s comfortable driving range ' +
    'between refuels, in kilometers, plus a short human-readable basis.',
  input_schema: {
    type: 'object',
    required: ['comfortable_km', 'basis'],
    properties: {
      comfortable_km: {
        type: ['integer', 'null'],
        description:
          'Comfortable range in WHOLE kilometers (200–1500). If the driver gave ' +
          'tank size + fuel economy, compute usable range and take ~80% as ' +
          'comfortable. If they named a make/model/year, estimate conservatively ' +
          'from typical specs for that vehicle. null ONLY when there is not enough ' +
          'information to estimate ("I don’t know", no vehicle or fuel detail). ' +
          'Always err short rather than long — never risk stranding the driver.',
      },
      basis: {
        type: 'string',
        description:
          'Very short phrase naming what the estimate is based on, e.g. ' +
          '"a 2018 Hilux’s ~80 L diesel tank" or "60 L tank at ~12 km/L". Empty ' +
          'string when comfortable_km is null.',
      },
    },
  },
};

export interface ComfortableRangeEstimate {
  /** Validated comfortable range in km, or null when not estimable. */
  km: number | null;
  /** Short human basis for the estimate (for the confirm prompt). */
  basis: string;
}

/**
 * Validate a model-returned comfortable range: a whole number inside the product
 * km band. Pure — exported for unit testing. Anything else (non-number, float,
 * out of band, null) collapses to null so a hallucinated value can't slip in.
 */
export function validateComfortableKm(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return null;
  }
  if (raw < FUEL_STOP_SPACING_KM_MIN || raw > FUEL_STOP_SPACING_KM_MAX) return null;
  return raw;
}

interface EstimateOpts {
  userId?: string;
  tripId?: string;
}

/**
 * Estimate a comfortable range from the driver's free-text description of what
 * they know. Returns `{ km: null, basis: '' }` when it can't (no key, error,
 * timeout, or insufficient signal). Never throws.
 */
export async function estimateComfortableRange(
  text: string,
  opts: EstimateOpts = {},
): Promise<ComfortableRangeEstimate> {
  const anthropic = getClient();
  if (!anthropic) return { km: null, basis: '' };
  const trimmed = text.trim();
  if (!trimmed) return { km: null, basis: '' };

  const system =
    `You estimate a driver's COMFORTABLE driving range between refuels (in km) and ` +
    `record it via the record_comfortable_range tool. Call that tool exactly once; ` +
    `output nothing else.\n` +
    `- "Comfortable" means how far they'd happily drive before refuelling, with a ` +
    `sensible reserve already left in the tank — NOT the absolute tank-dry maximum.\n` +
    `- If they give tank size + fuel economy, compute usable range and take ~80% as ` +
    `comfortable.\n` +
    `- If they name a make/model/year, estimate conservatively from typical specs.\n` +
    `- Valid range is ${FUEL_STOP_SPACING_KM_MIN}–${FUEL_STOP_SPACING_KM_MAX} km. Always ` +
    `err on the short side — never risk stranding them.\n` +
    `- If there isn't enough information to estimate, set comfortable_km=null.`;

  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create(
      {
        model: RANGE_ESTIMATE_MODEL,
        max_tokens: 128,
        temperature: 0,
        system,
        tools: [RANGE_TOOL],
        tool_choice: { type: 'tool', name: RANGE_TOOL.name },
        messages: [{ role: 'user', content: trimmed.slice(0, 400) }],
      },
      { timeout: RANGE_ESTIMATE_TIMEOUT_MS },
    );
  } catch (err) {
    console.warn(
      `[parseComfortableRange] LLM estimate failed (model=${RANGE_ESTIMATE_MODEL}): ${
        (err as Error)?.message ?? err
      }`,
    );
    return { km: null, basis: '' };
  }

  if (opts.userId) {
    void logAnthropicUsageWithFallback({
      userId: opts.userId,
      tripId: opts.tripId ?? null,
      model: RANGE_ESTIMATE_MODEL,
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: resp.usage?.cache_read_input_tokens ?? 0,
      success: true,
    }).catch(() => {});
  }

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === RANGE_TOOL.name,
  );
  if (!toolUse) return { km: null, basis: '' };
  const input = (toolUse.input ?? {}) as { comfortable_km?: unknown; basis?: unknown };
  const km = validateComfortableKm(input.comfortable_km);
  const basis = km != null && typeof input.basis === 'string' ? input.basis.trim() : '';
  return { km, basis };
}
