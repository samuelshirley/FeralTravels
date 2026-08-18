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
export const PENNY_MODEL = 'claude-sonnet-4-6';

/**
 * Small, cheap, fast model for the onboarding date-text → ISO conversion. A
 * trivial extraction task, so it doesn't need Penny's planning model. Swap to
 * PENNY_MODEL if you'd rather track a single model ID.
 */
export const DATE_PARSE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Small, cheap model for the onboarding "I don't know my range" helper: turns
 * what the driver knows (make/model/year, or tank size + economy) into a
 * conservative COMFORTABLE-range estimate they then confirm. Same class of
 * trivial extraction/estimation task as the date parser.
 */
export const RANGE_ESTIMATE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Small, cheap model for the onboarding "first-message intent scan": reads the
 * driver's opening trip description and transcribes any onboarding variables it
 * already contains (start date, comfortable/hard-max range) so those questions
 * can be skipped or prefilled. Pure extraction — the same trivial class as the
 * date parser, and the LLM only converts; the server re-validates every field.
 */
export const ONBOARDING_SCAN_MODEL = 'claude-haiku-4-5-20251001';
