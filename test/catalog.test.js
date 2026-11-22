import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/catalog.js';
import { createSearch } from '../src/search.js';

const skill = name => ({ skill_name: name, skill_url: `https://github.com/owner/repo/tree/fixed/${name}` });

test('catalog hides only missing revisions, keeps original ranking and can paginate after a full page is filtered', async () => {
  const records = ['missing', 'live', 'limited'].map(skill);
  const run = createCatalog(async request => request.action === 'source-status'
    ? records.map((record, index) => ({ url: record.skill_url, status: ['missing', 'available', 'unknown'][index] }))
    : { mode: 'keyword', page: 2, limit: 3, skills: records });
  const result = await run({ action: 'discover', page: 2 });
  assert.deepEqual(result.skills, records.slice(1));
  assert.equal(result.page, 2);
  assert.equal(result.filteredCount, 1);
  assert.equal(result.hasMore, true);
  const empty = createCatalog(async request => request.action === 'source-status'
    ? records.map(record => ({ url: record.skill_url, status: 'missing' }))
    : { mode: 'keyword', page: 1, limit: 3, skills: records });
  assert.equal((await empty({ action: 'discover' })).hasMore, true);
});

test('catalog reuses checks across browse/search and retries expired or uncertain sources', async () => {
  let now = 1000, checks = [], missing = true;
  const records = [skill('recovering'), skill('uncertain')];
  const run = createCatalog(async request => {
    if (request.action !== 'source-status') return { mode: 'keyword', limit: 2, skills: records };
    checks.push(request.urls);
    return request.urls.map(url => ({ url, status: url === records[0].skill_url ? missing ? 'missing' : 'available' : 'unknown' }));
  }, () => now);
  assert.deepEqual((await run({ action: 'discover' })).skills, [records[1]]);
  missing = false;
  assert.deepEqual((await run({ action: 'search' })).skills, [records[1]]);
  assert.deepEqual(checks[1], [records[1].skill_url]);
  now += 300_001;
  assert.deepEqual((await run({ action: 'discover' })).skills, records);
  assert.deepEqual(checks[2], records.map(record => record.skill_url));
});

test('checker outages keep results and cancellation remains cancellation', async () => {
  const record = skill('live');
  const run = createCatalog(async request => {
    if (request.action === 'source-status') throw new Error('temporary outage');
    return { mode: 'keyword', limit: 1, skills: [record] };
  });
  assert.deepEqual((await run({ action: 'discover' })).skills, [record]);
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  const cancelled = createCatalog(async request => {
    if (request.action === 'source-status') { controller.abort(reason); throw reason; }
    return { skills: [record] };
  });
  await assert.rejects(cancelled({ action: 'search' }, controller.signal), error => error === reason);
});

test('smart search tops up after filtering and never puts missing sources in client-side candidate pages', async () => {
  const dead = skill('dead'), live = skill('live');
  const queries = [];
  const run = createCatalog(async request => {
    if (request.action === 'source-status') return request.urls.map(url => ({ url, status: url === dead.skill_url ? 'missing' : 'available' }));
    queries.push(request);
    return { skills: request.mode === 'keyword' ? [dead] : [live] };
  });
  const search = createSearch(run, { capture() { throw new Error('No model expansion needed'); } });
  const result = await search({ q: 'frontend', limit: 1, includeCandidates: true });
  assert.ok(queries.some(request => request.mode === 'vector'));
  assert.deepEqual(result.skills, [live]);
  assert.deepEqual(result.candidates, [live]);
  assert.equal(result.candidateCount, 1);
});
