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
