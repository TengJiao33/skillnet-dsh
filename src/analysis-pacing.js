import { setTimeout } from 'node:timers/promises';

const startInterval = 2_000;
const serialInterval = 5_000;
const backoff = [30_000, 60_000, 120_000];

function isRateLimit(error) {
  return error?.status === 429 || error?.statusCode === 429 ||
    /\b(?:request burst|too many requests|rate[ _-]limit[ _-](?:reached|exceeded)|(?:http|status(?: code)?)\s*[:=]?\s*429)\b/i.test(error?.message || '');
}

export function createAnalysisPacer(invoke, progress, {
  now = () => performance.now(),
  wait = (ms, signal) => setTimeout(ms, undefined, { signal }),
} = {}) {
  const active = new Set();
  let warmedUp = false;
  let capacity = 2;
  let successes = 0;
  let nextStart = 0;
  let stopped;

  async function acquire(signal) {
    for (;;) {
      signal?.throwIfAborted();
      if (stopped) throw stopped;
      if (active.size >= (warmedUp ? capacity : 1)) {
        await Promise.race(active);
        continue;
      }
      const remaining = nextStart - now();
      if (remaining > 0) {
        await wait(remaining, signal);
        continue;
      }
      // Reserve before yielding so parallel callers cannot take the same slot.
      const { promise, resolve } = Promise.withResolvers();
      active.add(promise);
      nextStart = now() + (capacity === 1 ? serialInterval : startInterval * 2 / capacity);
      return () => {
        active.delete(promise);
        resolve();
      };
    }
  }

  return async (payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      const release = await acquire(signal);
      try {
        signal?.throwIfAborted();
        const result = await invoke(payload, signal);
        warmedUp = true;
        if (++successes >= 8 && capacity < 4) {
          capacity++;
          successes = 0;
          progress(`请求稳定，调整为 ${capacity} 并发`);
        }
        return result;
      } catch (error) {
        if (signal?.aborted || !isRateLimit(error)) throw error;
        if (attempt === backoff.length) {
          stopped = new Error(`模型持续限流，已保留完成的建图缓存。稍后可重新点击建图。\n${error.message}`, { cause: error });
          throw stopped;
        }
        capacity = Math.max(1, Math.floor(capacity / 2));
        successes = 0;
        const retryAfter = error.headers?.get?.('retry-after') ?? error.headers?.['retry-after'];
        const seconds = Number(retryAfter);
        const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        const delay = Math.max(backoff[attempt], requestedDelay || 0);
        const time = now();
        nextStart = Math.max(nextStart, time + delay);
        progress(`模型请求过密，等待 ${Math.ceil((nextStart - time) / 1000)} 秒后${capacity === 1 ? '单并发' : capacity + ' 并发'}重试（${attempt + 1}/${backoff.length}）`);
      } finally { release(); }
    }
  };
}
