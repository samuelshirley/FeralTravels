#!/usr/bin/env node
/**
 * Turn Jev COMPARE on in production, with TypeSafe's hosted Jev.
 *
 *   node scripts/enable-jev-compare.mjs
 *
 * Run it from your own checkout (linked to Vercel, CLI logged in). It asks
 * for one thing — the TypeSafe API key, typed hidden — and does the rest:
 *
 *   1. Checks the Vercel CLI is logged in and the checkout is linked.
 *   2. Pulls the PRODUCTION environment to a private temp file (deleted on
 *      exit, whatever happens) for the database URL and the current JEV_*.
 *   3. Refuses to go on unless production already runs the consent-v2 build
 *      (migration 0049's `users.ai_consent_version` exists). Compare sends
 *      messages to TypeSafe; before v2 nothing tells users so.
 *   4. Checks the key against TypeSafe with a SYNTHETIC message (no user data).
 *   5. Sets JEV_BASE_URL, JEV_API_KEY and JEV_MODEL on Vercel Production —
 *      only the ones that differ.
 *   6. Redeploys production through GitHub Actions ("Deploy to production",
 *      workflow_dispatch on main) and waits for it. Production is a PREBUILT
 *      deploy, so a Vercel env change reaches nothing until a build runs; the
 *      Actions route keeps the same gate as a merge (CI green for that SHA).
 *   7. Sets `app_meta.jev_mode = 'compare'` and writes an `admin:jev-switch`
 *      usage_events row saying who did it and how — the same row /admin writes.
 *   8. Reads everything back and prints the effective state, including how
 *      many accounts have their OWN Jev mode (which wins over the global one),
 *      and offers to clear those.
 *
 * Idempotent: a second run changes nothing that is already right, says so,
 * and asks before redeploying again.
 *
 * Compare is MEASUREMENT ONLY: Haiku still decides every message and Penny
 * still answers every one; Jev's answers are logged beside them (/admin).
 * Only accounts that agreed to consent sheet v2 (which names TypeSafe) are
 * ever sent to Jev.
 *
 * To turn it off: /admin → Message classifier → HAIKU ONLY. No redeploy.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-1.13.0';
export const GH_REPO = 'samuelshirley/feraltravels';
export const DEPLOY_WORKFLOW = 'deploy-production.yml';
const VC = ['npx', '--yes', 'vercel'];

const BOLD = '\x1b[1m';
const GRN = '\x1b[32m';
const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

// ── Pure helpers (exported for scripts/enableJevCompare.test.ts) ─────────────

/** A dotenv file as `vercel env pull` writes it: KEY="value" lines. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
      // `vercel env pull` escapes newlines inside double quotes.
      v = v.replace(/\\n/g, '\n');
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Which variables to write. `current` is what Production holds (from the
 * pull; a Sensitive variable reads back empty). Returns, per name, whether it
 * must be removed first (it exists with another or unreadable value) and added.
 */
export function planEnvChanges(current, wanted) {
  const plan = [];
  for (const [name, value] of Object.entries(wanted)) {
    const have = current[name];
    if (have === value) {
      plan.push({ name, action: 'keep' });
    } else if (have === undefined) {
      plan.push({ name, action: 'add' });
    } else {
      plan.push({ name, action: 'replace' });
    }
  }
  return plan;
}

/** The TypeSafe probe: a synthetic message, the route question only. */
export function probeBody(model) {
  return {
    model,
    state: 'Message:\nconnectivity check from scripts/enable-jev-compare.mjs',
    questions: {
      route: {
        type: 'choice',
        instructions: 'Which one of these does the message ask for?',
        criteria: { needs_penny: 'Anything else.', off_topic: 'Nothing a road-trip planner can do.' },
      },
    },
  };
}

/** One line per account-override mode, for the summary. */
export function overrideSummary(counts) {
  const total = counts.on + counts.compare + counts.off;
  if (total === 0) return 'No account has its own Jev mode: every account follows the global switch.';
  return (
    `${total} account${total === 1 ? ' has' : 's have'} their own Jev mode, which wins over the global switch: ` +
    `${counts.on} Jev first, ${counts.compare} compare, ${counts.off} Haiku only.`
  );
}

// ── Side effects ─────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function die(message) {
  console.error(`${RED}${message}${OFF}`);
  process.exit(1);
}

/** Read a line with nothing echoed — the key never appears on screen. */
function askHidden(prompt) {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('this needs an interactive terminal (stdin is not a TTY)'));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolvePromise(buf.trim());
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** A visible y/N question. Anything but y/yes is no. */
function askYesNo(prompt) {
  return new Promise((resolvePromise) => {
    process.stdout.write(`${prompt} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolvePromise(/^\s*y(es)?\s*$/i.test(String(d)));
    });
  });
}

function vercel(args, input) {
  return run(VC[0], [...VC.slice(1), ...args], input === undefined ? {} : { input });
}

function setProductionVar(name, value, action) {
  if (action === 'replace') {
    const rm = vercel(['env', 'rm', name, 'production', '--yes']);
    if (rm.status !== 0) die(`Could not remove the old ${name} from Production:\n${rm.stderr || rm.stdout}`);
  }
  const add = vercel(['env', 'add', name, 'production'], value);
  if (add.status !== 0) die(`Could not set ${name} on Production:\n${add.stderr || add.stdout}`);
}

async function probeTypeSafe(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(probeBody(JEV_MODEL)),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function redeployViaActions() {
  const gh = run('gh', ['auth', 'status']);
  const actionsUrl = `https://github.com/${GH_REPO}/actions/workflows/${DEPLOY_WORKFLOW}`;
  if (gh.error || gh.status !== 0) {
    console.log(`${YEL}The GitHub CLI is not installed or not logged in (gh auth status failed).${OFF}`);
    console.log(`Redeploy by hand: ${BOLD}${actionsUrl}${OFF} → Run workflow → main.`);
    return { triggered: false, url: actionsUrl };
  }
  const before = new Date();
  const trig = run('gh', ['workflow', 'run', DEPLOY_WORKFLOW, '--ref', 'main', '-R', GH_REPO]);
  if (trig.status !== 0) die(`Could not start "Deploy to production":\n${trig.stderr || trig.stdout}`);
  // Find the run that just started (workflow_dispatch, on main, created after `before`).
  let runId = null;
  for (let i = 0; i < 30 && runId === null; i++) {
    const list = run('gh', [
      'run', 'list', '-R', GH_REPO, '--workflow', DEPLOY_WORKFLOW, '--event', 'workflow_dispatch',
      '--branch', 'main', '--limit', '5', '--json', 'databaseId,createdAt',
    ]);
    if (list.status === 0) {
      const runs = JSON.parse(list.stdout || '[]');
      const fresh = runs.find((r) => new Date(r.createdAt).getTime() >= before.getTime() - 5_000);
      if (fresh) runId = fresh.databaseId;
    }
    if (runId === null) spawnSync('sleep', ['2']);
  }
  if (runId === null) die(`Started "Deploy to production" but could not find the run. Check ${actionsUrl}`);
  console.log(`${DIM}Watching run ${runId} (https://github.com/${GH_REPO}/actions/runs/${runId})…${OFF}`);
  const watch = run('gh', ['run', 'watch', String(runId), '-R', GH_REPO, '--exit-status'], { stdio: 'inherit' });
  if (watch.status !== 0) die(`"Deploy to production" run ${runId} did not succeed. Nothing in the database was changed.`);
  return { triggered: true, runId };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);

  console.log(`${BOLD}Jev compare → production${OFF}\n`);

  // 1. Vercel CLI and link.
  if (!existsSync('.vercel/project.json') && !existsSync('.vercel/repo.json')) {
    die('This checkout is not linked to a Vercel project. Run: npx vercel link');
  }
  const who = vercel(['whoami']);
  if (who.status !== 0) die('The Vercel CLI is not logged in. Run: npx vercel login');
  const whoami = (who.stdout || '').trim().split('\n').pop() || 'unknown';
  console.log(`Vercel: logged in as ${whoami}`);

  // 2. Production env, privately, deleted on exit.
  const tmp = mkdtempSync(join(tmpdir(), 'jev-compare-'));
  chmodSync(tmp, 0o700);
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

  const envFile = join(tmp, 'production.env');
  const pull = vercel(['env', 'pull', envFile, '--environment=production', '--yes']);
  if (pull.status !== 0 || !existsSync(envFile)) die(`Could not pull the Production environment:\n${pull.stderr || pull.stdout}`);
  chmodSync(envFile, 0o600);
  const prodEnv = parseEnvFile(readFileSync(envFile, 'utf8'));
  const databaseUrl = prodEnv.DATABASE_URL;
  if (!databaseUrl) die('Production has no readable DATABASE_URL (is it a Sensitive variable?). Nothing was changed.');

  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { ssl: 'require', max: 1 });
  try {
    // 3. Production must already run the consent-v2 build.
    const [col] = await sql`
      select 1 as ok from information_schema.columns
       where table_name = 'users' and column_name = 'ai_consent_version'`;
    if (!col) {
      die(
        'Production does not run the consent-v2 build yet (users.ai_consent_version is missing).\n' +
          'Merge the PR that adds it first: until then nothing tells users their messages go to TypeSafe.',
      );
    }
    console.log('Production: consent v2 is deployed.');

    // 4. The key, hidden, checked against TypeSafe with a synthetic message.
    const existingKey = prodEnv.JEV_API_KEY ?? '';
    let key = await askHidden(
      existingKey
        ? 'TypeSafe API key (hidden; press Enter to keep the one already on Production): '
        : 'TypeSafe API key (hidden): ',
    );
    if (!key) key = existingKey;
    if (!key) die('No key entered and none on Production. Nothing was changed.');

    console.log(`${DIM}Checking the key with a synthetic message (no user data)…${OFF}`);
    let probe;
    try {
      probe = await probeTypeSafe(key);
    } catch (err) {
      die(`Could not reach ${JEV_BASE_URL}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    }
    if (probe.status === 401 || probe.status === 403) die(`TypeSafe refused the key (HTTP ${probe.status}). Nothing was changed.`);
    if (probe.status !== 200) die(`TypeSafe answered HTTP ${probe.status} to the check. Nothing was changed.`);
    const echoed = probe.body && typeof probe.body.model === 'string' ? probe.body.model : '(no model echoed)';
    const routeAnswer = probe.body?.answers?.route?.choice;
    console.log(`${GRN}TypeSafe accepted the key${OFF} (model ${echoed}; answered the test question: ${routeAnswer ?? 'no'}).`);

    // 5. Vercel Production env.
    const plan = planEnvChanges(prodEnv, { JEV_BASE_URL, JEV_MODEL, JEV_API_KEY: key });
    for (const p of plan) {
      const value = p.name === 'JEV_BASE_URL' ? JEV_BASE_URL : p.name === 'JEV_MODEL' ? JEV_MODEL : key;
      if (p.action === 'keep') {
        console.log(`  ${p.name.padEnd(13)} unchanged`);
        continue;
      }
      setProductionVar(p.name, value, p.action);
      console.log(`  ${p.name.padEnd(13)} ${p.action === 'add' ? 'added' : 'replaced'}${p.name === 'JEV_API_KEY' ? '' : ` (${value})`}`);
    }
    const envChanged = plan.some((p) => p.action !== 'keep');

    // 6. Redeploy, so the running deployment has them.
    let redeploy = envChanged;
    if (!envChanged) {
      redeploy = await askYesNo('The env was already right. Redeploy production anyway (only needed if an earlier run stopped before deploying)?');
    }
    if (redeploy) {
      const r = redeployViaActions();
      if (!r.triggered) {
        await askYesNo('Run it now, wait for it to finish green, then answer y to continue (n stops here)').then((yes) => {
          if (!yes) die('Stopped before the database switch. Re-run this script after the deploy.');
        });
      } else {
        console.log(`${GRN}Production redeployed${OFF} (run ${r.runId}).`);
      }
    }

    // 7. The global switch, with an audit row.
    const [before] = await sql`select value from app_meta where key = 'jev_mode'`;
    if (before?.value !== 'compare') {
      await sql.begin(async (tx) => {
        await tx`
          insert into app_meta (key, value) values ('jev_mode', 'compare')
          on conflict (key) do update set value = excluded.value`;
        await tx`
          insert into usage_events (user_id, provider, requests, success, error_message)
          values (null, 'admin:jev-switch', 0, true,
                  ${`${whoami} set Jev to COMPARE for every account without an override (scripts/enable-jev-compare.mjs; was ${before?.value ?? 'unset'})`})`;
      });
      console.log(`Global switch: ${before?.value ?? 'unset'} → compare (audit row written).`);
    } else {
      console.log('Global switch: already compare.');
    }

    // 8. Read back, and the overrides that win over it.
    const [mode] = await sql`select value from app_meta where key = 'jev_mode'`;
    const [ov] = await sql`
      select count(*) filter (where jev_mode = 'on')::int as on,
             count(*) filter (where jev_mode = 'compare')::int as compare,
             count(*) filter (where jev_mode = 'off')::int as off
        from users`;
    const [consent] = await sql`
      select count(*) filter (where ai_consent_at is not null)::int as agreed,
             count(*) filter (where ai_consent_version >= 2)::int as v2
        from users`;
    const overrides = { on: ov.on, compare: ov.compare, off: ov.off };
    console.log(`\n${BOLD}Effective state${OFF}`);
    console.log(`  app_meta.jev_mode  ${mode?.value ?? '<missing>'}`);
    console.log(`  Vercel Production  JEV_BASE_URL=${JEV_BASE_URL}  JEV_MODEL=${JEV_MODEL}  JEV_API_KEY=set`);
    console.log(`  Consent            ${consent.v2} of ${consent.agreed} agreeing accounts are on v2 (only they are compared)`);
    console.log(`  Overrides          ${overrideSummary(overrides)}`);

    const total = overrides.on + overrides.compare + overrides.off;
    if (total > 0 && (await askYesNo(`Clear all ${total} per-account overrides so every account follows compare?`))) {
      await sql.begin(async (tx) => {
        const cleared = await tx`update users set jev_mode = null where jev_mode is not null returning id`;
        await tx`
          insert into usage_events (user_id, provider, requests, success, error_message)
          values (null, 'admin:jev-user-override', 0, true,
                  ${`${whoami} cleared ${cleared.length} per-account Jev overrides (scripts/enable-jev-compare.mjs)`})`;
      });
      const [after] = await sql`select count(*)::int as n from users where jev_mode is not null`;
      console.log(`  Overrides          cleared; ${after.n} remain.`);
    }
    console.log(
      `\n${DIM}The app caches the switch for 30 s. Compare runs only where Jev is configured, so check /admin →\n` +
        `Message classifier: it should say "Jev at api.typesafe.ai (${JEV_MODEL}, key set)".${OFF}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`${RED}enable-jev-compare: ${err instanceof Error ? err.message : String(err)}${OFF}`);
    process.exit(1);
  });
}
