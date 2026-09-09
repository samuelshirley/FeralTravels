/**
 * Central registry of the Anthropic model IDs this app calls.
 *
 * Hardcoded on purpose — no per-request model fallback chains. But kept in ONE
 * place so that when a model is sunset there is a single file to update, and a
 * future admin-dashboard feature can read these to surface deprecation warnings.
 *
 * When updating: bump the ID, then run the app's Anthropic-backed paths (Penny
 * chat + onboarding date parsing) once to confirm the new ID is accepted.
 *
 * Last reviewed: 2026-06-26.
 */

/** Penny's planning / tool-use model (chat + nightly replan). */
// Haiku since 2026-09-09 (was claude-sonnet-4-6). Every token type bills at
// exactly one third of Sonnet's price; the Austin 14-leg turn measured $0.585 on
// Sonnet. The rulebook in claude.ts was written against Sonnet's mistakes, so
// the swap is an EXPERIMENT until the same prompts have been replayed and
// compared — `toolTrace` in penny_turns.result_meta is what makes the runs
// comparable.
export const PENNY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Small, cheap, fast model for the onboarding date-text → ISO conversion. A
 * trivial extraction task, so it doesn't need Penny's planning model. Swap to
 * PENNY_MODEL if you'd rather track a single model ID.
 */
export const DATE_PARSE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Small, cheap model for the onboarding "I don't know my range" helper: turns
 * what the driver knows (make/model/year, or tank size + economy) into a
 * conservative fuel-range estimate they then confirm. Same class of
 * trivial extraction/estimation task as the date parser.
 */
export const RANGE_ESTIMATE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Small, cheap model for the onboarding "first-message intent scan": reads the
 * driver's opening trip description and transcribes any onboarding variables it
 * already contains (start date, fuel range) so those questions
 * can be skipped or prefilled. Pure extraction — the same trivial class as the
 * date parser, and the LLM only converts; the server re-validates every field.
 */
export const ONBOARDING_SCAN_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The message-tier classifier: is this message about the trip, adjacent to it,
 * or junk?
 *
 * Same trivial-extraction class as the three above — one forced tool call, a
 * ~300-token prompt, `max_tokens: 60`, no history and no trip context beyond
 * the trip's own names. It runs only on messages the deterministic rules could
 * not settle, and it exists to be CHEAP: at roughly $0.0005 a call it is
 * one-170th of the planning turn it is deciding whether to spend, which is the
 * entire argument for having it rather than guessing with keywords.
 */
export const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
