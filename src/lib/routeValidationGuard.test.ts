import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every endpoint accepts ONE pre-declared shape. Decision G1.
 *
 * The trust boundary is strict on purpose: a route validates a Zod schema and
 * rejects anything off-contract. The temptation this guards against is
 * widening an endpoint to be helpful — accepting loose or free-text input so
 * the client can be sloppy. Free-text interpretation belongs ONLY at the
 * boundary that owns it (onboarding), never bolted onto a general edit
 * endpoint: `PATCH /api/trips/[id]` takes an already-resolved date and must not
 * run the LLM date parser.
 *
 * A `formData()` upload is the one legitimate variant — multipart is not a JSON
 * body — and must still validate every field through a named validator rather
 * than trusting the string.
 */

const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'src/app/api');

function routes(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

const all = routes(API).map((f) => ({ rel: relative(ROOT, f).split('\\').join('/'), src: readFileSync(f, 'utf8') }));

const READS_JSON = /await\s+\w+\.json\(\)/;
const READS_FORM = /await\s+\w+\.formData\(\)/;
const ZOD_PARSE = /\.(safeParse|parse)\s*\(/;
const NAMED_VALIDATOR = /parseUUID|parseCoords|validate[A-Z]/;

describe('API routes validate their input', () => {
  it('there are routes to check', () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it('every route reading a JSON body parses it with a schema', () => {
    const bad = all
      .filter((r) => READS_JSON.test(r.src) && !ZOD_PARSE.test(r.src))
      .map((r) => r.rel);
    expect(
      bad,
      'Declare a Zod schema and parse the body. Do NOT widen an endpoint to accept ' +
        'loose input to be helpful — reject anything off-contract.',
    ).toEqual([]);
  });

  it('every multipart upload validates its fields through a named validator', () => {
    const bad = all
      .filter((r) => READS_FORM.test(r.src) && !ZOD_PARSE.test(r.src) && !NAMED_VALIDATOR.test(r.src))
      .map((r) => r.rel);
    expect(bad, 'A form field is still untrusted input.').toEqual([]);
  });

  it('the general trip edit endpoint does not parse free text', () => {
    // The specific widening this decision was written about: `PATCH
    // /api/trips/[id]` must take an already-resolved ISO date, never run the
    // LLM date parser. That belongs to onboarding, which owns the boundary.
    const trip = all.find((r) => r.rel === 'src/app/api/trips/[id]/route.ts');
    expect(trip, 'the trip route moved').toBeDefined();
    expect(trip?.src).not.toMatch(/resolveStartDate|parseStartDate/);
  });
});
