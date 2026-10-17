import { setTimeout as delay } from 'node:timers/promises';

// Playwright's synchronous waitForFunction poller treats a Promise as truthy.
// Await each asynchronous check explicitly, then poll the resolved condition.
export async function pollAsync(check, { timeout = 10_000, interval = 50, description = 'asynchronous condition' } = {}) {
  const deadline = performance.now() + timeout;
  let attempts = 0;
  while (true) {
    attempts++;
    if (await check()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error(`Timed out waiting for ${description} after ${attempts} checks`);
    await delay(Math.min(interval,remaining));
  }
}

export function waitForAsync(page, predicate, arg, options) {
  return pollAsync(() => page.evaluate(predicate,arg), options);
}
