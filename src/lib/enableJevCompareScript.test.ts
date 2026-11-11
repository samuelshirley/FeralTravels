import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEPLOY_WORKFLOW,
  GH_REPO,
  JEV_BASE_URL,
  JEV_MODEL,
  overrideSummary,
  parseEnvFile,
  planEnvChanges,
  probeBody,
} from '../../scripts/enable-jev-compare.mjs';

/**
 * `scripts/enable-jev-compare.mjs` — what Sam runs on his Mac to turn compare
 * on in production. It cannot run here (it needs his Vercel login, his GitHub
 * login and the production database), so this holds the parts that decide
 * things, and the source-level promises the rest of it makes.
 */

const ROOT = join(__dirname, '..', '..');
const src = readFileSync(join(ROOT, 'scripts/enable-jev-compare.mjs'), 'utf8');

describe('the values it sets', () => {
  it('points at TypeSafe’s hosted Jev, the model measured offline', () => {
    expect(JEV_BASE_URL).toBe('https://api.typesafe.ai');
    expect(JEV_MODEL).toBe('jev-1.13.0');
  });

  it('passes the app’s own production config rules (https, no query, not local)', async () => {
    const { readJevConfig } = await import('@/server/jev/config');
    const r = readJevConfig({
      JEV_BASE_URL,
      JEV_MODEL,
      JEV_API_KEY: 'k',
      VERCEL_ENV: 'production',
    });
    expect(r).toMatchObject({ ok: true, config: { host: 'api.typesafe.ai', model: JEV_MODEL, apiKey: 'k' } });
  });

  it('redeploys through the real production workflow, which is dispatchable', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows', DEPLOY_WORKFLOW), 'utf8');
    expect(wf).toMatch(/^\s*workflow_dispatch:/m);
    expect(GH_REPO).toBe('samuelshirley/feraltravels');
  });
});

describe('parseEnvFile', () => {
  it('reads what `vercel env pull` writes', () => {
    expect(
      parseEnvFile(
        '# Created by Vercel CLI\nDATABASE_URL="postgres://u:p@h/db?sslmode=require"\nJEV_MODEL="jev-1.13.0"\nEMPTY=""\nBARE=x\n',
      ),
    ).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db?sslmode=require',
      JEV_MODEL: 'jev-1.13.0',
      EMPTY: '',
      BARE: 'x',
    });
  });
});

describe('planEnvChanges — idempotent', () => {
  const wanted = { JEV_BASE_URL, JEV_MODEL, JEV_API_KEY: 'new-key' };

  it('first run: adds all three', () => {
    expect(planEnvChanges({}, wanted).map((p) => p.action)).toEqual(['add', 'add', 'add']);
  });

  it('second run with the same key: changes nothing', () => {
    expect(planEnvChanges({ JEV_BASE_URL, JEV_MODEL, JEV_API_KEY: 'new-key' }, wanted).map((p) => p.action)).toEqual([
      'keep',
      'keep',
      'keep',
    ]);
  });

  it('a different or unreadable (Sensitive → empty) value is replaced, not duplicated', () => {
    expect(
      planEnvChanges({ JEV_BASE_URL: 'https://gpu.example.com', JEV_MODEL, JEV_API_KEY: '' }, wanted).map((p) => [
        p.name,
        p.action,
      ]),
    ).toEqual([
      ['JEV_BASE_URL', 'replace'],
      ['JEV_MODEL', 'keep'],
      ['JEV_API_KEY', 'replace'],
    ]);
  });
});

describe('the key check sends no user data', () => {
  it('a synthetic message and two criteria, nothing else', () => {
    const body = probeBody(JEV_MODEL);
    expect(body.state).toBe('Message:\nconnectivity check from scripts/enable-jev-compare.mjs');
    expect(Object.keys(body.questions)).toEqual(['route']);
    expect(body.model).toBe(JEV_MODEL);
  });
});

describe('overrideSummary', () => {
  it('says plainly when nobody overrides, and counts each mode when they do', () => {
    expect(overrideSummary({ on: 0, compare: 0, off: 0 })).toMatch(/every account follows the global switch/);
    expect(overrideSummary({ on: 1, compare: 0, off: 2 })).toBe(
      '3 accounts have their own Jev mode, which wins over the global switch: 1 Jev first, 0 compare, 2 Haiku only.',
    );
  });
});

describe('what the script promises, at source level', () => {
  it('reads the key hidden, never from an argument or a placeholder', () => {
    expect(src).toMatch(/setRawMode\(true\)/);
    expect(src).not.toMatch(/process\.argv\[2\]/);
    expect(src).not.toMatch(/YOUR_|<key>|REPLACE_ME|xxx/i);
  });

  it('pulls the production env into a private temp dir and deletes it on exit', () => {
    expect(src).toMatch(/mkdtempSync\(join\(tmpdir\(\)/);
    expect(src).toMatch(/chmodSync\(tmp, 0o700\)/);
    expect(src).toMatch(/chmodSync\(envFile, 0o600\)/);
    expect(src).toMatch(/process\.on\('exit', cleanup\)/);
    expect(src).toMatch(/rmSync\(tmp, \{ recursive: true, force: true \}\)/);
  });

  it('refuses to switch compare on before the consent-v2 build is in production', () => {
    const gate = src.indexOf("column_name = 'ai_consent_version'");
    const write = src.indexOf("insert into app_meta (key, value) values ('jev_mode', 'compare')");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });

  it('writes the switch and its audit row together, in one transaction', () => {
    const tx = src.slice(src.indexOf('await sql.begin(async (tx) => {'));
    const end = tx.indexOf('});');
    expect(tx.slice(0, end)).toMatch(/insert into app_meta/);
    expect(tx.slice(0, end)).toMatch(/'admin:jev-switch'/);
  });

  it('checks the Vercel login and says how to fix it', () => {
    expect(src).toMatch(/'whoami'/);
    expect(src).toMatch(/The Vercel CLI is not logged in\. Run: npx vercel login/);
  });
});
