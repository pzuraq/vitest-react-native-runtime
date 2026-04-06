/**
 * Retry — polling/retry logic for async UI assertions.
 */

export interface RetryOptions {
  timeout?: number;
  interval?: number;
}

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_INTERVAL = 50;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    // setImmediate is available in RN and yields to the event loop
    // without the timer scheduling issues that setTimeout has in Hermes.
    const si = (globalThis as any).setImmediate;
    if (si) {
      si(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT } = options;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
    }
    // Yield to let React commit pending state updates
    await yieldToEventLoop();
    // Extra yield every few attempts to ensure Fabric has time to commit
    if (attempts % 5 === 0) {
      await yieldToEventLoop();
    }
  }

  throw lastError;
}
