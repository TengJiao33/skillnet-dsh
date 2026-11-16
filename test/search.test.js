import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../src/search.js';

test('Chinese smart search falls back and fuses by source, preserving same-name skills', async () => {
  const calls = [];
  const skill = (url, description) => ({ skill_name: 'csv', skill_url: url, skill_description: description });
  const a = skill('https://github.com/a/b/tree/main/csv', '原始来源');
  const b = skill('https://github.com/c/d/tree/main/csv', '另一个同名技能');
  const search = createSearch(async request => {
    calls.push(request);
    return { skills: request.threshold === 0.8 ? [] : request.q === 'Extract PDF tables and validate CSV' ? [skill(a.skill_url.replace('/tree/', '/blob/') + '/SKILL.md', '重复来源'), b] : [a] };
  }, { capture: async () => ({ selection: {} }), invoke: async () => ({ content: '{"query":"Extract PDF tables and validate CSV"}' }) });
  const result = await search({ q: '提取 PDF 表格并检查 CSV', limit: 5 });
  assert.equal(calls[1].threshold, 0.65);
  assert.ok(calls.some(call => call.q === 'Extract PDF tables and validate CSV' && call.mode === 'vector'));
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0].skill_description, '原始来源');
});

test('search failure is distinct from no results and model failure retains original recall', async () => {
  const failure = createSearch(async () => { throw new Error('offline'); });
  await assert.rejects(failure({ q: 'csv' }), /检索失败.*连接/);
  const search = createSearch(async () => ({ skills: [{ skill_url: 'https://github.com/a/b/tree/main/csv' }] }), { capture: async () => { throw new Error('no model'); } });
  const result = await search({ q: '检查表格' });
  assert.equal(result.skills.length, 1);
  assert.equal(result.warnings.length, 1);
});

test('partial semantic timeouts preserve matches and expose a concise Chinese warning without the request URL', async () => {
  const record = { skill_name: 'frontend', skill_url: 'https://github.com/owner/repo/tree/main/frontend' };
  const calls = [];
  const search = createSearch(async request => {
    calls.push(request);
    if (request.mode === 'keyword') return { skills: [] };
    if (request.threshold === 0.8) return { skills: [record] };
    throw new Error('Search failed: 504 Server Error: Gateway Timeout for url: http://api-skillnet.openkg.cn/v1/search?q=private-fixture&mode=vector');
  });
  const result = await search({ q: 'build a responsive frontend page' });
  assert.deepEqual(result.skills, [record]);
  assert.equal(calls.filter(call => call.mode === 'vector').length, 2);
  assert.deepEqual(result.warnings, ['语义检索响应超时，请稍后重试。']);
  assert.doesNotMatch(JSON.stringify(result.warnings), /https?:|private-fixture|Server Error/);
});

test('short PDF lookup recalls known sources, respects name relevance before stars, and skips redundant inference', async () => {
  const local = { skill_name: 'pdf', skill_url: 'https://github.com/local/skills/tree/main/pdf', repo_name: 'local/skills', stars: 5, skill_description: 'Original PDF source' };
  const official = { skill_name: 'pdf', skill_url: 'https://github.com/anthropics/skills/tree/main/pdf', repo_name: 'anthropics/skills', stars: 91061 };
  const popularOther = { skill_name: 'unrelated', skill_url: 'https://github.com/popular/project/tree/main/other', stars: 999999 };
  const related = { skill_name: 'nano-pdf', skill_url: 'https://github.com/owner/repo/tree/main/nano-pdf', stars: 230194 };
  const calls = [];
  const search = createSearch(async request => {
    calls.push(request);
    assert.equal(request.mode, 'keyword');
    assert.equal(request.q, 'PDF');
    return { skills: request.sort_by === 'stars' ? [popularOther, related, official, { ...local, skill_description: 'Duplicate record' }] : [local] };
  }, { capture() { throw new Error('A sufficient literal lookup must not call a model'); } });
  const result = await search({ q: 'PDF处理', limit: 2, includeCandidates: true, category: 'Development' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.category === 'Development'));
  assert.deepEqual(result.skills.map(skill => skill.skill_url), [official.skill_url, local.skill_url]);
  assert.equal(result.skills[1].skill_description, 'Original PDF source');
  assert.equal(result.candidateCount, 4);
  assert.equal(result.candidates.length, 4);
  assert.deepEqual(result.warnings, []);
  const toolResult = await search({ q: 'PDF处理', limit: 2 });
  assert.equal(toolResult.candidates, undefined);
  assert.equal(toolResult.skills.length, 2);
});

test('sufficient semantic matches stop before threshold retries and English model expansion', async () => {
  const calls = [];
  const skills = Array.from({ length: 3 }, (_, i) => ({ skill_name: 'plot-' + i, skill_url: 'https://github.com/owner/repo/tree/main/plot-' + i }));
  const search = createSearch(async request => { calls.push(request); return { skills }; }, { capture() { throw new Error('Unnecessary model call'); } });
  const result = await search({ q: '科研绘图', limit: 3 });
  assert.equal(result.skills.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threshold, 0.8);
});

test('a failed semantic service is not retried with looser thresholds or translated queries', async () => {
  const calls = [];
  const search = createSearch(async request => {
    calls.push(request);
    if (request.mode === 'vector') throw new Error('504 Server Error: Gateway Timeout');
    return { skills: [{ skill_name: 'documents', skill_url: 'https://github.com/owner/repo/tree/main/documents' }] };
  }, { capture() { throw new Error('Do not translate for a failed semantic service'); } });
  const result = await search({ q: '整理一批报告文档', limit: 5 });
  assert.equal(calls.filter(call => call.mode === 'vector').length, 1);
  assert.equal(calls.filter(call => call.mode === 'keyword').length, 1);
  assert.equal(result.skills.length, 1);
  assert.match(result.warnings[0], /语义检索响应超时/);
});

test('equal relevance in natural-language recall uses repository stars as a tie-breaker', async () => {
  const low = { skill_name: 'plot-one', skill_url: 'https://github.com/a/skills/tree/main/plot', stars: 1 };
  const high = { skill_name: 'plot-two', skill_url: 'https://github.com/b/skills/tree/main/plot', stars: 1000 };
  const search = createSearch(async request => ({ skills: request.threshold === 0.8 ? [low] : [high] }));
  const result = await search({ q: '制作科研图表', limit: 2 });
  assert.deepEqual(result.skills.map(skill => skill.stars), [1000, 1]);
});

test('explicit search distinguishes access and rate failures while keeping raw details out of the public message', async () => {
  for (const [code, expected] of [[403, /访问权限/], [429, /频繁/], [504, /响应超时/]]) {
    const failure = new Error(`${code} Server Error for url: https://example.test/search?q=private-fixture`);
    const search = createSearch(async () => { throw failure; });
    await assert.rejects(search({ q: 'pdf', mode: 'keyword' }), error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /https?:|private-fixture/);
      assert.equal(error.cause, failure);
      return true;
    });
  }
});

test('search cancellation is preserved instead of becoming a service warning', async () => {
  const controller = new AbortController();
  const stopped = new Error('fixture cancellation');
  const search = createSearch(async () => { controller.abort(stopped); throw new Error('504 timeout'); });
  await assert.rejects(search({ q: 'pdf', mode: 'vector' }, { signal: controller.signal }), error => error === stopped);
});

test('explicit retrieval modes preserve filters and do not invoke any model', async () => {
  let request;
  const search = createSearch(async value => { request = value; return { skills: [] }; }, { capture() { throw new Error('must not call'); } });
  await search({ q: 'CSV', mode: 'keyword', category: 'Development', page: 3, min_stars: 12 });
  assert.equal(request.mode, 'keyword'); assert.equal(request.page, 3); assert.equal(request.category, 'Development'); assert.equal(request.min_stars, 12);
});

test('semantic recall enforces star filters locally and does not pretend to sort missing dates', async () => {
  const search = createSearch(async () => ({ skills: [{ skill_url: 'a', stars: 0 }, { skill_url: 'b', stars: 24 }, { skill_url: 'c', stars: 42 }] }));
  for (const mode of ['auto', 'vector']) {
    const result = await search({ q: 'CSV', mode, min_stars: 20, sort_by: 'stars' });
    assert.deepEqual(result.skills.map(s => s.stars), [42, 24]);
    await assert.rejects(search({ q: 'CSV', mode, sort_by: 'recent' }), /关键词/);
  }
});
