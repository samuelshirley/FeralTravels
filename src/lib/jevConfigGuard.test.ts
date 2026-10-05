import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isLocalHost, readJevConfig } from '@/server/jev/config';

/**
 * Where Jev is, and who may say so. Decision I21.
 *
 * `JEV_BASE_URL` is where every classifier-path chat message goes once the
 * switch is on, so the config is a privacy boundary, not a setting:
 *
 *  - A local host (localhost, loopback, private ranges, `.local`) is accepted
 *    only on a laptop — never when `VERCEL_ENV` or `CI` is set, where it names
 *    something inside Vercel's network or the runner, not Sam's GPU.
 *  - Production needs https AND a key: the body is a driver's message.
 *  - The config lives in the server environment only. A `NEXT_PUBLIC_JEV*`
 *    name would ship the URL (or the key) to every browser, and a workflow
 *    that sets `JEV_*` would point CI — which must never call Jev — at it.
 *
 * Every refusal is "not configured", which is Haiku, which is today.
 */

const ROOT = join(__dirname, '..', '..');

const PUBLIC = 'https://jev.example.com';
const withKey = { JEV_API_KEY: 'k' };

describe('local hosts are refused anywhere but a laptop', () => {
  const locals = [
    'http://localhost:8000',
    'http://api.localhost',
    'http://127.0.0.1:8000',
    'http://127.8.9.10',
    'http://0.0.0.0:8000',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.20:8000',
    'http://169.254.169.254',
    'http://100.64.0.1',
    'http://[::1]:8000',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::ffff:10.1.2.3]',
    'http://gpu.local:8000',
    'http://gpu.internal',
  ];

  it.each(locals)('%s is accepted on a laptop', (url) => {
    expect(readJevConfig({ JEV_BASE_URL: url }).ok).toBe(true);
  });

  it.each(locals)('%s is refused under CI', (url) => {
    const r = readJevConfig({ JEV_BASE_URL: url, CI: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/local host/);
  });

  it.each(locals)('%s is refused on any Vercel deployment', (url) => {
    for (const VERCEL_ENV of ['preview', 'development', 'production']) {
      const r = readJevConfig({ JEV_BASE_URL: url, VERCEL_ENV, ...withKey });
      expect(r.ok, `${url} under VERCEL_ENV=${VERCEL_ENV}`).toBe(false);
    }
  });

  it('public hosts are not mistaken for local ones', () => {
    for (const h of ['jev.example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1', 'localhost.example.com', '2606:4700::1111']) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });
});

describe('production needs https and a key', () => {
  it('refuses http', () => {
    const r = readJevConfig({ JEV_BASE_URL: 'http://jev.example.com', VERCEL_ENV: 'production', ...withKey });
    expect(r).toEqual({ ok: false, reason: 'JEV_BASE_URL must be https in production' });
  });

  it('refuses a missing key', () => {
    const r = readJevConfig({ JEV_BASE_URL: PUBLIC, VERCEL_ENV: 'production' });
    expect(r).toEqual({ ok: false, reason: 'JEV_API_KEY is required in production' });
  });

  it('accepts https with a key', () => {
    const r = readJevConfig({ JEV_BASE_URL: PUBLIC, VERCEL_ENV: 'production', ...withKey });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ baseUrl: PUBLIC, host: 'jev.example.com', apiKey: 'k', timeoutMs: 800, t1Min: 0.85 });
  });
});

describe('a bad config is "not configured", never a throw', () => {
  const bad: Array<[string, Record<string, string>]> = [
    ['unset', {}],
    ['blank', { JEV_BASE_URL: '  ' }],
    ['not a URL', { JEV_BASE_URL: 'jev' }],
    ['ftp', { JEV_BASE_URL: 'ftp://jev.example.com' }],
    ['credentials in the URL', { JEV_BASE_URL: 'https://u:p@jev.example.com' }],
    ['a query string', { JEV_BASE_URL: `${PUBLIC}?x=1` }],
    ['a zero timeout', { JEV_BASE_URL: PUBLIC, JEV_TIMEOUT_MS: '0' }],
    ['a huge timeout', { JEV_BASE_URL: PUBLIC, JEV_TIMEOUT_MS: '60000' }],
    ['a non-numeric timeout', { JEV_BASE_URL: PUBLIC, JEV_TIMEOUT_MS: 'fast' }],
    ['a threshold below 0.5', { JEV_BASE_URL: PUBLIC, JEV_T1_MIN: '0.3' }],
    ['a threshold above 1', { JEV_BASE_URL: PUBLIC, JEV_T1_MIN: '1.2' }],
  ];
  it.each(bad)('%s', (_name, env) => {
    const r = readJevConfig(env);
    expect(r.ok).toBe(false);
  });

  it('reads the env overrides when they are valid', () => {
    const r = readJevConfig({ JEV_BASE_URL: `${PUBLIC}/`, JEV_TIMEOUT_MS: '400', JEV_T1_MIN: '0.9', JEV_MODEL: 'm' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ baseUrl: PUBLIC, timeoutMs: 400, t1Min: 0.9, model: 'm', apiKey: null });
  });
});

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'ios' || name === 'android') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs|cjs|json)$/.test(name) || name === 'app.config.js') out.push(p);
  }
  return out;
}

describe('the config lives in the server environment only', () => {
  it('no NEXT_PUBLIC_JEV* / EXPO_PUBLIC_JEV* anywhere in src/ or mobile/', () => {
    const forbidden = /\b(NEXT|EXPO)_PUBLIC_JEV/;
    const hits = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'mobile'))]
      // This file names the pattern in order to forbid it.
      .filter((f) => f !== __filename)
      .filter((f) => forbidden.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(hits, 'Jev config must never be readable by a client bundle.').toEqual([]);
  });

  it('config.ts reads process.env and nothing a request can supply', () => {
    const src = readFileSync(join(ROOT, 'src/server/jev/config.ts'), 'utf8');
    expect(src).toMatch(/env: Env = process\.env/);
    expect(src).not.toMatch(/\b(headers|cookies|searchParams|NextRequest|Request)\b/);
  });

  it('no GitHub workflow sets JEV_*', () => {
    const dir = join(ROOT, '.github/workflows');
    const hits = readdirSync(dir)
      .filter((n) => /\.ya?ml$/.test(n))
      .filter((n) => /\bJEV_[A-Z_]+\s*:/.test(readFileSync(join(dir, n), 'utf8')));
    expect(hits, 'CI must never call Jev. Unit tests mock fetch.').toEqual([]);
  });
});
