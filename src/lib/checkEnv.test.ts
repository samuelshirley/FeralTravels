/**
 * The guard for scripts/check-env.sh — the `predev` check that refuses to
 * start `next dev` on an env var that resolves to EMPTY.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it has already happened:
 *
 * `vercel env pull` writes a `.env.local` listing every key with an empty
 * value. Next loads `.env.local` AHEAD of `.env`, and dotenv does NOT skip an
 * empty declaration — `KEY=` sets the variable to the empty string rather than
 * falling through. So a repo with a perfectly good ANTHROPIC_API_KEY in `.env`
 * ran a dev server that had none: every `/api/trip/replan` answered 503, the
 * log filled with `MissingSecret` from an equally-empty AUTH_SECRET, and the
 * iOS chat-keyboard e2e flow reported GREEN over the top of all of it.
 *
 * WHAT THE ASSERTIONS ENCODE, and why each one is here:
 *
 * 1. The message must NAME THE FILE. "ANTHROPIC_API_KEY is empty" sends the
 *    reader to `.env`, where the key is fine, and they disbelieve the error.
 *    So the shadowed-value line is asserted, not just the exit code.
 * 2. "Empty" and "absent" are DIFFERENT and must read differently. A key
 *    nobody declared is not being shadowed by anything, and saying a filename
 *    there would be a lie.
 * 3. The fatal/warn split is asserted both ways. A contributor with no
 *    Anthropic key of their own must still get a dev server.
 * 4. The `predev` wiring is asserted, because the guard is worth nothing if
 *    `npm run dev` stops running it — the same reason decideMobileRelease.test
 *    asserts that mobile.yml still invokes its script.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.join(__dirname, '..', '..');

interface Result {
  code: number;
  out: string;
}

/**
 * Run the guard in a throwaway tree containing only the env files given.
 *
 * A real directory rather than a mocked filesystem: the thing under test is a
 * bash script reading files, and the precedence it implements is dotenv's, so
 * anything that stubs the reading tests the stub.
 */
function runGuard(files: Record<string, string>, env: Record<string, string> = {}): Result {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-env-'));
  try {
    mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    cpSync(path.join(REPO, 'scripts', 'check-env.sh'), path.join(dir, 'scripts', 'check-env.sh'));
    cpSync(
      path.join(REPO, 'scripts', 'lib', 'env-value.sh'),
      path.join(dir, 'scripts', 'lib', 'env-value.sh')
    );
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);

    try {
      // `2>&1` inside the shell, not two pipes: the guard writes its findings
      // to STDERR (correctly — they are diagnostics), and execFileSync returns
      // only stdout, so a passing run with warnings came back as an empty
      // string and the warn-only assertions failed against a working guard.
      const out = execFileSync('bash', ['-c', 'bash scripts/check-env.sh 2>&1'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // A clean environment, so the developer's own shell cannot supply a
        // value and turn a red case green — which would make this suite pass
        // on one machine and fail on another.
        // NODE_ENV is carried because the repo augments ProcessEnv to require
        // it; nothing in the guard reads it.
        env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV ?? 'test', ...env },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_ENV = [
  'DATABASE_URL=postgres://example/db',
  'AUTH_SECRET=a-real-secret',
  'ANTHROPIC_API_KEY=sk-ant-example',
  'AUTH_RESEND_KEY=re_example',
  '',
].join('\n');

/** Exactly what `vercel env pull` leaves behind. */
const VERCEL_EMPTY_LOCAL = [
  '# Created by Vercel CLI',
  'DATABASE_URL=""',
  'AUTH_SECRET=""',
  'ANTHROPIC_API_KEY=""',
  'AUTH_RESEND_KEY=""',
  '',
].join('\n');

describe('check-env.sh', () => {
  it('passes when .env alone supplies everything', () => {
    expect(runGuard({ '.env': GOOD_ENV }).code).toBe(0);
  });

  it('refuses to start when .env.local empties a key .env sets correctly', () => {
    const { code, out } = runGuard({ '.env': GOOD_ENV, '.env.local': VERCEL_EMPTY_LOCAL });
    expect(code).toBe(1);
    expect(out).toContain('Refusing to start');
  });

  it('names the shadowing file AND the shadowed one', () => {
    // The whole point. Without both halves the reader opens .env, finds the
    // key present and correct, and concludes the guard is broken.
    const { out } = runGuard({ '.env': GOOD_ENV, '.env.local': VERCEL_EMPTY_LOCAL });
    expect(out).toContain('declared EMPTY in .env.local');
    expect(out).toContain('a real value exists in .env');
  });

  it('says "not set" rather than blaming a file when nothing declares the key', () => {
    // Absent is not shadowed. Naming a file here would send the reader to a
    // file that never mentioned the key.
    const { out } = runGuard({ '.env': 'DATABASE_URL=postgres://example/db\nAUTH_SECRET=s\n' });
    expect(out).toContain('ANTHROPIC_API_KEY');
    expect(out).toContain('not set in the environment');
    expect(out).not.toContain('a real value exists in');
  });

  it('is fatal for DATABASE_URL and AUTH_SECRET', () => {
    for (const key of ['DATABASE_URL', 'AUTH_SECRET']) {
      const emptied = `${key}=\n`;
      const { code, out } = runGuard({ '.env': GOOD_ENV, '.env.local': emptied });
      expect(code, `${key} must be fatal`).toBe(1);
      expect(out).toContain(key);
    }
  });

  it('only warns for ANTHROPIC_API_KEY and AUTH_RESEND_KEY', () => {
    // A contributor with no Anthropic key of their own still gets a dev
    // server: Penny is broken, the rest of the app is not.
    for (const key of ['ANTHROPIC_API_KEY', 'AUTH_RESEND_KEY']) {
      const { code, out } = runGuard({ '.env': GOOD_ENV, '.env.local': `${key}=\n` });
      expect(code, `${key} must not be fatal`).toBe(0);
      expect(out).toContain(key);
    }
  });

  it('lets a real exported value beat an empty declaration', () => {
    // dotenv never overwrites something already in the environment, so this
    // has to stay green or the guard would block a correctly-configured shell.
    const { code } = runGuard(
      { '.env': GOOD_ENV, '.env.local': VERCEL_EMPTY_LOCAL },
      {
        DATABASE_URL: 'postgres://exported/db',
        AUTH_SECRET: 'exported-secret',
        ANTHROPIC_API_KEY: 'sk-ant-exported',
        AUTH_RESEND_KEY: 're_exported',
      }
    );
    expect(code).toBe(0);
  });

  it('is still wired as predev, so npm run dev cannot skip it', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.predev).toContain('scripts/check-env.sh');
  });
});
