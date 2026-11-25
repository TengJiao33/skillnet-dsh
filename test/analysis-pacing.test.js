import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createAnalysisPacer } from '../src/analysis-pacing.js';

function clock() {
  let time = 0;
  const timers = new Set();
  return {
    now: () => time,
    wait(ms, signal) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const timer = { end: time + ms, resolve };
      const abort = () => reject(signal.reason);
      timers.add(timer);
      signal?.addEventListener('abort', abort, { once: true });
      return promise.finally(() => {
        signal?.removeEventListener('abort', abort);
        timers.delete(timer);
      });
    },
    async advance(ms) {
      time += ms;
      for (const timer of timers) if (timer.end <= time) timer.resolve();
      await setImmediate();
    },
  };
}

const burst = () => new Error('DSH model failed (PI_AI_ERROR): System protection triggered by request burst. Please slow down traffic growth and increase requests gradually before retrying.');

test('starts serially and spaces requests when growing to two concurrent model calls', async () => {
  const timer = clock();
  const calls = [];
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const run = createAnalysisPacer(async payload => {
    calls.push([payload, timer.now()]);
    if (payload === 'first') await first.promise;
    if (payload === 'second') await second.promise;
    return payload;
  }, () => assert.fail('A healthy run should not cool down'), timer);
  const a = run('first');
  const b = run('second');
  await timer.advance(0);
  await timer.advance(4_000);
  assert.deepEqual(calls, [['first', 0]]);
  first.resolve();
  await a;
  await timer.advance(0);
  assert.deepEqual(calls, [['first', 0], ['second', 4_000]]);
  const c = run('third');
  await timer.advance(0);
  await timer.advance(1_999);
  assert.equal(calls.length, 2);
  await timer.advance(1);
  assert.equal(await c, 'third');
  assert.deepEqual(calls.at(-1), ['third', 6_000]);
  second.resolve();
  assert.equal(await b, 'second');
});

test('backs off on the reported burst, retries the same item, and keeps later requests serial', async () => {
  const timer = clock();
  const calls = [];
  const messages = [];
  const retry = Promise.withResolvers();
  const original = { label: '画像 A' };
  let attempts = 0;
  const run = createAnalysisPacer(async payload => {
    calls.push([payload, timer.now()]);
    if (payload === original) {
      if (++attempts === 1) throw burst();
      await retry.promise;
    }
    return payload;
  }, message => messages.push(message), timer);
  const a = run(original);
  await timer.advance(0);
  const b = run({ label: '画像 B' });
  await timer.advance(0);
  await timer.advance(29_999);
  assert.equal(calls.length, 1);
  assert.match(messages[0], /30 秒后单并发/);
  await timer.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], original);
  await timer.advance(5_000);
  assert.equal(calls.length, 2);
  retry.resolve();
  assert.equal(await a, original);
  assert.deepEqual(await b, { label: '画像 B' });
  assert.equal(calls[2][1], 35_000);
});

test('stops the queue after three cooldowns and leaves unrelated errors unchanged', async () => {
  const timer = clock();
  const providerError = burst();
  const attempts = [];
  const run = createAnalysisPacer(async () => {
    attempts.push(timer.now());
    throw providerError;
  }, () => {}, timer);
  const failed = assert.rejects(run('profile'), error => error.cause === providerError && /模型持续限流/.test(error.message));
  await timer.advance(0);
  await timer.advance(30_000);
  await timer.advance(60_000);
  await timer.advance(120_000);
  await failed;
  await assert.rejects(run('another'), /模型持续限流/);
  assert.deepEqual(attempts, [0, 30_000, 90_000, 210_000]);

  const unrelated = new Error('invalid model credentials');
  const direct = createAnalysisPacer(async () => { throw unrelated; }, () => assert.fail('unexpected retry'), timer);
  await assert.rejects(direct('profile'), error => error === unrelated);
});

test('cancelling during a cooldown prevents a retry', async () => {
  const timer = clock();
  const controller = new AbortController();
  let attempts = 0;
  const run = createAnalysisPacer(async () => {
    attempts++;
    throw Object.assign(new Error('provider error'), { status: 429 });
  }, () => {}, timer);
  const cancelled = assert.rejects(run('profile', controller.signal), { name: 'AbortError' });
  await timer.advance(0);
  controller.abort();
  await cancelled;
  await timer.advance(180_000);
  assert.equal(attempts, 1);
});

test('eight successful calls restore capacity after a rate limit', async () => {
  let now = 0, attempts = 0;
  const progress = [];
  const run = createAnalysisPacer(async () => {
    if (++attempts === 1) throw burst();
  }, line => progress.push(line), { now: () => now, wait: async ms => { now += ms; } });
  for (let i = 0; i < 8; i++) await run({});
  assert.match(progress.at(-1), /2 并发/);
});
