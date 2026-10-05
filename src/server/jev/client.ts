import type { JevConfig } from './config';
import type { SystemOneRequest } from './question';

/**
 * One POST to `{base}/v1/systemone`. Plain `fetch`, no SDK — the wire API is
 * one endpoint and one JSON body, and an SDK would be a dependency whose only
 * job is to hide the timeout this function exists to own.
 *
 * The AbortController covers the WHOLE exchange, body included: a server that
 * sends headers promptly and then trickles the body has not answered in time
 * either. Every outcome is a value; nothing here throws.
 *
 * Error text never includes the response body — a misbehaving backend could
 * echo the driver's message back, and these strings are logged.
 */

export type JevCallResult =
  | { ok: true; body: unknown; latencyMs: number }
  | {
      ok: false;
      kind: 'http' | 'timeout' | 'network' | 'bad_json';
      status: number | null;
      latencyMs: number;
      message: string;
    };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function postSystemOne(
  config: JevConfig,
  request: SystemOneRequest,
  fetchImpl: FetchLike = fetch,
  clock: () => number = Date.now
): Promise<JevCallResult> {
  const started = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const elapsed = () => clock() - started;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  try {
    const res = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      // Drain nothing: an error body is not read, so it cannot be logged.
      return { ok: false, kind: 'http', status: res.status, latencyMs: elapsed(), message: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, kind: 'timeout', status: res.status, latencyMs: elapsed(), message: `timed out after ${config.timeoutMs} ms` };
      }
      return {
        ok: false,
        kind: 'bad_json',
        status: res.status,
        latencyMs: elapsed(),
        message: err instanceof Error ? err.name : 'unparseable body',
      };
    }
    return { ok: true, body, latencyMs: elapsed() };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, kind: 'timeout', status: null, latencyMs: elapsed(), message: `timed out after ${config.timeoutMs} ms` };
    }
    return {
      ok: false,
      kind: 'network',
      status: null,
      latencyMs: elapsed(),
      message: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}
