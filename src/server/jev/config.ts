/**
 * Where Jev lives, read from the SERVER environment and nowhere else.
 *
 * Never from a request, and never under a `NEXT_PUBLIC_*` name: the base URL
 * is where every classifier-path chat message goes once the switch is on, so a
 * value the browser can see — or a caller can supply — is a value somebody
 * else can point at their own server. `jevConfigGuard.test.ts` holds both.
 *
 * ── A rejected config is "not configured", never an exception ──
 *
 * The message gate asks for this on every classifier-path message while the
 * switch is on. Any answer other than a usable config sends that message to
 * Haiku exactly as if Jev had never been built, and the reason is shown on
 * /admin next to the switch — so a typo in Vercel costs a few Haiku calls and
 * is visible, rather than costing a 500 and being invisible.
 *
 * ── Local hosts only where there is a local machine ──
 *
 * `localhost`, loopback, private ranges and `.local` names are accepted only
 * when BOTH `VERCEL_ENV` and `CI` are unset — i.e. on a laptop. On Vercel such
 * a URL points at something inside Vercel's network rather than Sam's box, and
 * in CI it points at the runner; neither is the GPU it was meant to name.
 *
 * In production the URL must be https and a key is required: the request body
 * is a driver's message.
 */

export interface JevConfig {
  baseUrl: string;
  /** The URL's host, for /admin. Never the key. */
  host: string;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  /** Jev settles a message only at or above this top probability. */
  t1Min: number;
}

export type JevConfigResult =
  | { ok: true; config: JevConfig }
  | { ok: false; reason: string };

/**
 * The model id sent when `JEV_MODEL` is unset — what Laya's open-source
 * Jev-compatible server calls its typed-decision model.
 *
 * Here and not in `src/lib/models.ts`, on purpose. That file is the registry of
 * ANTHROPIC model ids, and it is mirrored byte for byte into
 * `mobile/shared/lib/models.ts`: a server-only default placed there changes a
 * file under `mobile/`, which `decide-mobile-release.mjs` treats as a reason to
 * publish an OTA update to every tester's phone.
 */
export const DEFAULT_JEV_MODEL = 'typed-decisions';

export const DEFAULT_TIMEOUT_MS = 800;
export const DEFAULT_T1_MIN = 0.85;
/** The longest a gate may wait on Jev. Beyond this Haiku is simply faster. */
const MAX_TIMEOUT_MS = 5000;
/** Below this "confident" means nothing — a three-way coin toss tops out at 0.34. */
const MIN_T1_MIN = 0.5;

type Env = Record<string, string | undefined>;

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

/**
 * Is this host on the machine, or on a network only it can reach?
 *
 * Covers the names and literal addresses: `localhost` and `*.localhost`,
 * `.local` (mDNS), IPv4 loopback / 0.0.0.0 / 10/8 / 172.16/12 / 192.168/16 /
 * link-local 169.254/16 / CGNAT 100.64/10, and IPv6 loopback, unique-local
 * (fc00::/7) and link-local (fe80::/10). A public NAME that happens to resolve
 * to a private address is not caught here — that would need DNS at config
 * time, and https + a key in production is the defence that covers it.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
    // IPv4-mapped — judge the embedded address. `new URL()` rewrites
    // `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so both spellings are read.
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (dotted) return isLocalHost(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isLocalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return false;
}

/** Read and judge the config. Pure over `env`; never throws. */
export function readJevConfig(env: Env = process.env): JevConfigResult {
  const raw = env.JEV_BASE_URL;
  if (blank(raw)) return { ok: false, reason: 'JEV_BASE_URL is not set' };

  let url: URL;
  try {
    url = new URL(raw!.trim());
  } catch {
    return { ok: false, reason: 'JEV_BASE_URL is not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'JEV_BASE_URL must be http or https' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'JEV_BASE_URL carries credentials; use JEV_API_KEY' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'JEV_BASE_URL must not carry a query or fragment' };
  }

  const onLaptop = blank(env.VERCEL_ENV) && blank(env.CI);
  if (isLocalHost(url.hostname) && !onLaptop) {
    return {
      ok: false,
      reason: `JEV_BASE_URL is a local host (${url.hostname}), refused under ${
        blank(env.VERCEL_ENV) ? 'CI' : `VERCEL_ENV=${env.VERCEL_ENV}`
      }`,
    };
  }

  const apiKey = blank(env.JEV_API_KEY) ? null : env.JEV_API_KEY!.trim();
  if (env.VERCEL_ENV === 'production') {
    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'JEV_BASE_URL must be https in production' };
    }
    if (!apiKey) return { ok: false, reason: 'JEV_API_KEY is required in production' };
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (!blank(env.JEV_TIMEOUT_MS)) {
    const n = Number(env.JEV_TIMEOUT_MS);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) {
      return { ok: false, reason: `JEV_TIMEOUT_MS must be a whole number of ms, 1–${MAX_TIMEOUT_MS}` };
    }
    timeoutMs = n;
  }

  let t1Min = DEFAULT_T1_MIN;
  if (!blank(env.JEV_T1_MIN)) {
    const n = Number(env.JEV_T1_MIN);
    if (!Number.isFinite(n) || n < MIN_T1_MIN || n > 1) {
      return { ok: false, reason: `JEV_T1_MIN must be between ${MIN_T1_MIN} and 1` };
    }
    t1Min = n;
  }

  const model = blank(env.JEV_MODEL) ? DEFAULT_JEV_MODEL : env.JEV_MODEL!.trim();

  return {
    ok: true,
    config: {
      baseUrl: url.toString().replace(/\/+$/, ''),
      host: url.host,
      apiKey,
      model,
      timeoutMs,
      t1Min,
    },
  };
}
