/**
 * Architectural guardrail: no external API calls during trip viewing.
 *
 * These tests scan the client-side UI components that render trip data and
 * assert they do NOT make fetch calls to external APIs (Google, Anthropic).
 * If someone adds a `fetch('/api/places/...')` or `DirectionsService.route()`
 * to a view component, these tests should catch it.
 *
 * Why source-level scanning instead of runtime e2e? Because:
 * 1. It's fast (pure string matching, no browser needed)
 * 2. It catches the problem at the right layer (the code, not the symptom)
 * 3. It gives a clear failure message pointing to the file and pattern
 *
 * The principle: UI components should ONLY read from props/state that came
 * from the DB via getTripFull(). External API calls belong in the write path
 * (Penny tools, fuel planning, replan dispatcher).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const COMPONENTS_DIR = path.resolve(__dirname, '../components');

/**
 * Patterns that indicate an external API call from a client component.
 * Each has a human-readable description for the failure message.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /DirectionsService/,
    description: 'Google DirectionsService — routes should come from stored geometry',
  },
  {
    pattern: /fetch\s*\(\s*[`'"]\/api\/places\/photos/,
    description: 'Fetching place photos from API — photos should come from stop.photos in DB',
  },
  {
    pattern: /fetch\s*\(\s*[`'"]\/api\/directions/,
    description: 'Fetching directions from API — should use stored polyline geometry',
  },
  {
    pattern: /importLibrary\s*\(\s*['"]routes['"]\s*\)/,
    description: 'Loading Google Maps routes library — not needed when using stored geometry',
  },
];

/**
 * Files explicitly allowed to contain these patterns (e.g. deliberate
 * user-initiated actions, not passive viewing).
 */
const ALLOWED_FILES = new Set<string>([
]);

function getAllTsxFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsxFiles(fullPath));
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('No external API calls in view-layer components', () => {
  const files = getAllTsxFiles(COMPONENTS_DIR);

  // Sanity check: we should find at least TripMap.tsx and StopsSection.tsx
  it('finds component files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
    const names = files.map((f) => path.basename(f));
    expect(names).toContain('TripMap.tsx');
    expect(names).toContain('StopsSection.tsx');
  });

  for (const file of files) {
    const relPath = path.relative(COMPONENTS_DIR, file);
    if (ALLOWED_FILES.has(relPath)) continue;

    const content = fs.readFileSync(file, 'utf-8');

    for (const { pattern, description } of FORBIDDEN_PATTERNS) {
      it(`${relPath} does not contain: ${description}`, () => {
        const match = content.match(pattern);
        if (match) {
          // Find line number for helpful error message
          const lines = content.slice(0, match.index).split('\n');
          const lineNum = lines.length;
          expect.fail(
            `Found forbidden pattern in ${relPath}:${lineNum}\n` +
              `  Pattern: ${description}\n` +
              `  Match: "${match[0]}"\n\n` +
              `  Fix: Move this external API call to the write path (Penny tools, ` +
              `fuel planning, or replan dispatcher) and persist the result in the DB.`
          );
        }
      });
    }
  }
});
