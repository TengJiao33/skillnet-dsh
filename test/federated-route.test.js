import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { exploreLibraries } from '../src/federated-route.js';

const pick = (id, description) => ({ id, name: id, description, source: '# ' + description });
const reports = { item: { id: 'reports', name: '报表分析' }, skills: [
  pick('explore-data', '检查缺失值和字段类型'), pick('shared', '报表模板')] };
const publishing = { item: { id: 'publishing', name: '报表发布' }, skills: [
  pick('publish-report', '发布已经核验的报表')] };
const figures = { item: { id: 'figures', name: '学术绘图' }, skills: [
  pick('figure-export', '输出论文期刊要求的 SVG 图'), pick('shared', '论文常用示例')] };
const groups = [reports, publishing, figures];

test('single-library discovery exposes searchable scope and lets the selector ask for clarification', async () => {
  const signal = AbortSignal.timeout(5000);
  for (const [query, libraryId] of [['检查地区字段并列出缺失值', 'reports'], ['处理下这份报表', null]]) {
    let wiki;
    const result = await exploreLibraries(groups, { query, k: 5, combine: false }, async payload => {
      wiki = payload.root;
      assert.equal(payload.method, 'explore');
      const prompt = JSON.parse(payload.prompt);
      assert.equal(prompt.task, query);
      assert.equal(prompt.libraries[0].skills[0].description, '检查缺失值和字段类型');
      assert.equal(prompt.libraries[1].name, '报表发布');
      const index = await readFile(join(wiki, 'index.md'), 'utf8');
      assert.match(index, /报表分析/);
      assert.match(index, /报表发布/);
      assert.match(await readFile(join(wiki, 'catalog-1-1.json'), 'utf8'), /检查缺失值/);
      await assert.rejects(stat(join(wiki, 'sources')), { code: 'ENOENT' });
      const json = JSON.stringify({ libraryId, reason: 'Fixture selection.' });
      return { content: libraryId ? json : '已查看目录。\n\n```json\n' + json + '\n```' };
    }, signal);
    assert.equal(result.libraryId, libraryId);
    await assert.rejects(stat(wiki), { code: 'ENOENT' });
  }
});

test('explicit cross-library selection preserves source library identity and exposes chosen source pages', async () => {
  const result = await exploreLibraries(groups, { query: '检查缺失再生成投稿 SVG', k: 3, combine: true }, async payload => {
    assert.equal(JSON.parse(payload.prompt).libraries[2].skills[0].name, 'figure-export');
    const a = JSON.parse(await readFile(join(payload.root, 'catalog-1-1.json'), 'utf8'))[0];
    const b = JSON.parse(await readFile(join(payload.root, 'catalog-3-1.json'), 'utf8'))[0];
    assert.match(await readFile(join(payload.root, a.source), 'utf8'), /检查缺失/);
    assert.match(await readFile(join(payload.root, b.source), 'utf8'), /SVG/);
    const json = JSON.stringify({ skills: [{ id: a.id, reason: '检查数据' }, { id: b.id, reason: '输出图' }] });
    return { content: '已查看源码。\n\n```json\n' + json + '\n```' };
  }, AbortSignal.timeout(5000));
  assert.deepEqual(result.picks.map(row => [row.item.id, row.skill.id]), [
    ['reports', 'explore-data'], ['figures', 'figure-export'],
  ]);
});

test('library output and cross picks cannot invent IDs or select conflicting native names', async () => {
  const signal = AbortSignal.timeout(5000);
  await assert.rejects(exploreLibraries(groups, { query: 'test', k: 4, combine: false },
    async () => ({ content: '{"libraryId":"other","reason":"invalid"}' }), signal), /无效的技能库/);
  await assert.rejects(exploreLibraries(groups, { query: 'test', k: 4, combine: true },
    async () => ({ content: '{"skills":[{"id":"s2","reason":"one"},{"id":"s5","reason":"two"}]}' }), signal), /重复/);
  await assert.rejects(exploreLibraries(groups, { query: 'test', k: 4, combine: true },
    async () => ({ content: '{"skills":[{"id":"shared","reason":"ambiguous"}]}' }), signal), /未知/);
  const resolved = await exploreLibraries(groups, { query: 'test', k: 2, combine: true },
    async () => ({ content: '{"skills":[{"id":"explore-data","reason":"analysis"},{"id":"s3","reason":"publish"}]}' }), signal);
  assert.deepEqual(resolved.picks.map(({ item, skill }) => [item.id, skill.id]), [
    ['reports', 'explore-data'], ['publishing', 'publish-report'],
  ]);
});
