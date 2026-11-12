import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CITY_HINT_BY_REGION, TRIP_INTENT_PROMPTS_BY_REGION } from './onboardingForm';

/**
 * The first-message examples are regional, and the SERVER picks the region
 * (`x-vercel-ip-country` → `localizeOnboardingSnapshot`). A client that types
 * one region's example into its own markup shows a US family "Lisbon, Girona,
 * Tromsø" no matter what the server sent — which is exactly what both
 * ChatPanels did until 2026-11-11. Clients render `question.prompts` and
 * `question.cityHint`; no example string may appear in a client file.
 */
const CLIENT_FILES = ['src/components/ChatPanel.tsx', 'mobile/components/ChatPanel.tsx'];

const EXAMPLES = [
  ...Object.values(TRIP_INTENT_PROMPTS_BY_REGION).flat(),
  ...Object.values(CITY_HINT_BY_REGION),
];

describe('regional prompt examples come from the server, never a client literal', () => {
  it.each(CLIENT_FILES)('%s contains no regional example string', (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    const found = EXAMPLES.filter((e) => src.includes(e));
    expect(found).toEqual([]);
  });
});
