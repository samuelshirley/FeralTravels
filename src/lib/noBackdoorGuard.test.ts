/**
 * Architectural guardrail: there is NO auth backdoor. Anywhere. Ever.
 *
 * Auth happens exactly three ways: Google OAuth, Sign in with Apple (web via
 * Auth.js when configured, native via /api/mobile/oauth/exchange), or the real
 * emailed OTP code (E2E reads the code for its OWN fixture address from
 * `/api/test/otp`, which mints nothing). The `/api/test/*` endpoints may only
 * manipulate fixture DATA — they must never mint a session, set an auth
 * cookie, or bypass sign-in.
 *
 * Source-level scanning (same approach as noExternalCallsGuard.test.ts): fast,
 * catches the problem at the code layer, and fails with a pointer to the file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '..');

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /backdoor/i,
    description:
      'the word "backdoor" — the auth backdoor was removed 2026-07-02; nothing may reintroduce one',
  },
  {
    pattern: /AUTH_TEST_BACKDOOR/,
    description: 'the removed AUTH_TEST_BACKDOOR env family',
  },
  {
    pattern: /createTestSession/,
    description: 'test session minting — E2E signs in via the real OTP flow',
  },
];

// The guard tests themselves (and this file) legitimately name the forbidden
// tokens. Everything else in src/ must be clean.
const ALLOWED_FILES = new Set<string>([
  'lib/noBackdoorGuard.test.ts',
  'server/auth/test-endpoints.test.ts',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

function getAllSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllSourceFiles(fullPath));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('No auth backdoor exists anywhere in src/', () => {
  const files = getAllSourceFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('the deleted backdoor modules stay deleted', () => {
    for (const relic of [
      'server/auth/test-backdoor.ts',
      'server/auth/test-session.ts',
      'app/api/test/session/route.ts',
    ]) {
      expect(fs.existsSync(path.join(SRC_DIR, relic)), `${relic} must not exist`).toBe(false);
    }
  });

  it('the login page has no test sign-in path (only Google / Apple + OTP email)', () => {
    const login = fs.readFileSync(path.join(SRC_DIR, 'app/login/page.tsx'), 'utf-8');
    expect(login).not.toMatch(/test.?sign.?in/i);
    expect(login).not.toMatch(/instant session/i);
  });

  it('the auth config registers no Credentials provider', () => {
    // OTP sign-in is handled outside Auth.js (signInWithOtp); Google and
    // Apple are the only Auth.js providers, and both verify the email
    // themselves. A Credentials provider is how the old backdoor snuck in —
    // its reappearance is a red flag.
    const authConfig = fs.readFileSync(path.join(SRC_DIR, 'server/auth/index.ts'), 'utf-8');
    expect(authConfig).not.toMatch(/next-auth\/providers\/credentials/);
  });

  for (const file of files) {
    const relPath = path.relative(SRC_DIR, file).split(path.sep).join('/');
    if (ALLOWED_FILES.has(relPath)) continue;

    const content = fs.readFileSync(file, 'utf-8');

    for (const { pattern, description } of FORBIDDEN_PATTERNS) {
      const match = content.match(pattern);
      if (!match) continue;
      it(`${relPath} must not contain ${description}`, () => {
        const lineNum = content.slice(0, match.index).split('\n').length;
        expect.fail(
          `Found forbidden pattern in src/${relPath}:${lineNum}\n` +
            `  Pattern: ${description}\n` +
            `  Match: "${match[0]}"\n\n` +
            `  There is no auth backdoor in this app. E2E authenticates through the\n` +
            `  real OTP flow and fixture endpoints only touch data.`,
        );
      });
    }
  }
});
