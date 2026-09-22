import { describe, expect, it } from 'vitest';
import {
  PROVIDER_RETRY_DELAYS_MS,
  exchangeRetryDelayMs,
  withExchangeRetry,
  type ExchangeFailure,
} from './oauthExchangeRetry';

/** Stands in for the app's ApiError. */
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

const classify = (err: unknown): ExchangeFailure | null =>
  err instanceof HttpFailure ? { status: err.status, code: err.code } : null;

/** An exchange that fails with each error in turn, then succeeds. */
function scripted(failures: Error[]) {
  let calls = 0;
  const run = async () => {
    const failure = failures[calls++];
    if (failure) throw failure;
    return 'session';
  };
  return { run, calls: () => calls };
}

function recordSleeps() {
  const sleeps: number[] = [];
  return { sleep: async (ms: number) => void sleeps.push(ms), sleeps };
}

const unavailable = () => new HttpFailure(503, 'ProviderUnavailable');
const invalid = () => new HttpFailure(401, 'InvalidToken');

describe('silent retry of the OAuth exchange', () => {
  it('retries ProviderUnavailable and returns the session when the server recovers', async () => {
    const { run, calls } = scripted([unavailable(), unavailable()]);
    const { sleep, sleeps } = recordSleeps();
    await expect(withExchangeRetry(run, classify, sleep)).resolves.toBe('session');
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([...PROVIDER_RETRY_DELAYS_MS]);
  });

  it('gives up after the last scheduled retry and surfaces the 503, so the copy can blame the provider', async () => {
    const { run, calls } = scripted([unavailable(), unavailable(), unavailable(), unavailable()]);
    const { sleep } = recordSleeps();
    await expect(withExchangeRetry(run, classify, sleep)).rejects.toMatchObject({
      status: 503,
      code: 'ProviderUnavailable',
    });
    expect(calls()).toBe(PROVIDER_RETRY_DELAYS_MS.length + 1);
  });

  it('retries InvalidToken exactly once — the old server said 401 for an unreachable provider (#39)', async () => {
    const once = scripted([invalid()]);
    await expect(withExchangeRetry(once.run, classify, recordSleeps().sleep)).resolves.toBe(
      'session'
    );

    const twice = scripted([invalid(), invalid()]);
    await expect(withExchangeRetry(twice.run, classify, recordSleeps().sleep)).rejects.toMatchObject(
      { status: 401, code: 'InvalidToken' }
    );
    expect(twice.calls()).toBe(2);
  });

  it.each([
    ['TokenAlreadyUsed', 401],
    ['EmailNotVerified', 401],
    ['RateLimited', 429],
    ['ProviderNotConfigured', 503],
    ['circuit_open', 503],
  ])('never retries %s (%i): retrying cannot change the answer', async (code, status) => {
    const { run, calls } = scripted([new HttpFailure(status, code)]);
    await expect(withExchangeRetry(run, classify, recordSleeps().sleep)).rejects.toMatchObject({
      code,
    });
    expect(calls()).toBe(1);
  });

  it('rethrows a non-HTTP failure (offline, cancelled) untouched and at once', async () => {
    const offline = new Error('Network request failed');
    const { run, calls } = scripted([offline]);
    await expect(withExchangeRetry(run, classify, recordSleeps().sleep)).rejects.toBe(offline);
    expect(calls()).toBe(1);
  });

  it('the policy is keyed on status AND code', () => {
    expect(exchangeRetryDelayMs({ status: 500, code: 'ProviderUnavailable' }, 0)).toBeNull();
    expect(exchangeRetryDelayMs({ status: 503, code: null }, 0)).toBeNull();
  });
});
