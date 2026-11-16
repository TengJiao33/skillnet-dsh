import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createBackend } from '../src/backend.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-host-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'); await mkdir(skills);
  for (const name of ['csv-first', 'csv-second']) {
    await mkdir(join(skills, name));
    await writeFile(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Process CSV rows\n---\n# CSV\nProcess CSV rows and report findings.\n`);
  }
  let embeddingCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/embeddings') { res.writeHead(400); res.end('Unexpected model request'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); embeddingCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', model: 'fixture-vector', data: body.input.map((_text, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const backend = createBackend({
    resolveExecutable: async value => value,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env, SKILLNET_CONFIG: join(root, 'no-user-config.json') }, stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal });
      child.stderr.resume();
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); });
      return { stdin: child.stdin, stdout: child.stdout, done, terminate: async () => { if (child.exitCode === null) child.kill() }, waitForExit: () => done };
    },
  });
  t.after(() => backend.dispose());
  const request = { action: 'analyze', retrievalMode: 'vector', sourcePath: skills, indexPath: join(root, 'index'), _host_model: { provider: 'fixture-a', model: 'current-model' }, _settings: { embedding_api_key: 'fixture-vector-key', embedding_base_url: `http://127.0.0.1:${server.address().port}/v1`, embedding_model: 'fixture-vector' } };
  return { root, skills, backend, request, embeddings: () => embeddingCalls };
}

function answer(payload) {
  const input = JSON.parse(payload.prompt);
  if (input.skill_id) return { content: JSON.stringify({ capability: { text: 'CSV processing ' + input.skill_id, evidence: [{ line: 6 }] }, when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] }) };
  const [first, second] = input.skills;
  return { content: JSON.stringify({ decision: { outcome: 'related', relations: [{ source: first.skill_id, target: second.skill_id, type: 'similar_to', contexts: [{ scenario: 'CSV rows', explanation: 'Both process CSV rows.', conditions: [], source_evidence: [{ line: 6 }], target_evidence: [{ line: 6 }] }] }] } }) };
}

test('stock analysis uses DSH for profiles and relations, keeps indexes/cache, and partitions selected models', async t => {
  const f = await fixture(t); const seen = [];
  const infer = async payload => { seen.push(payload); assert.equal(payload.method, 'chat'); assert.equal(payload.timeout_ms, 600_000); assert.match(payload.label, /^(提取画像|判断关系)：csv-/); assert.match(payload.system, /JSON schema:/); await setTimeout(20); return answer(payload); };
  const run = request => f.backend(request, AbortSignal.timeout(20_000), infer);
  const result = await run(f.request);
  assert.equal(result.skill_count, 2); assert.equal(result.relation_counts.similar_to, 1);
  assert.equal(seen.length, 3); assert.ok(f.embeddings() > 0);
  const snapshot = join(f.request.indexPath, (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim());
  const graphPath = join(snapshot, 'graph.json'); const graph = JSON.parse(await readFile(graphPath, 'utf8'));
  for (const skill of graph.skills) assert.equal(skill.profile.capability.text, 'CSV processing ' + skill.skill_id);
  await readFile(join(snapshot, 'bm25.sqlite'));
  await readFile(join(snapshot, 'embeddings.npz'));
  await run(f.request); assert.equal(seen.length, 3);
  await run({ ...f.request, _host_model: { provider: 'fixture-b', model: 'current-model' } }); assert.equal(seen.length, 6);
  const previous = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  await assert.rejects(f.backend({ ...f.request, _host_model: { provider: 'invalid-response', model: 'current-model' } }, AbortSignal.timeout(20_000), async () => ({ content: '{}' })));
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), previous);
});

test('stock evaluation keeps the original prompt, injection scan and five-dimension validation over DSH', async t => {
  const f = await fixture(t); const seen = [];
  const request = { action: 'evaluate', path: join(f.skills, 'csv-first'), cache_dir: join(f.root, 'evaluation'), _host_model: f.request._host_model };
  const valid = Object.fromEntries(['safety', 'completeness', 'executability', 'cost_awareness', 'maintainability'].map(key => [key, { level: 'Good', reason: '依据技能内容完成评估。' }]));
  const result = await f.backend(request, AbortSignal.timeout(20_000), async payload => { seen.push(payload); return { content: JSON.stringify(valid) }; });
  assert.equal(seen.length, 1); assert.equal(seen[0].method, 'chat');
  assert.equal(seen[0].timeout_ms, 120_000);
  assert.match(seen[0].prompt, /Process CSV rows and report findings/);
  assert.match(seen[0].prompt, /cost_awareness/);
  for (const key of Object.keys(valid)) assert.equal(result[key].level, 'Good');
  assert.ok(result.prompt_injection_scan);
  assert.equal(f.embeddings(), 0);
  await assert.rejects(f.backend(request, AbortSignal.timeout(20_000), async () => ({ content: '{"safety":{"level":"Good"}}' })));
});

test('an interrupted profile keeps successful cache entries and the previous graph for resumption', async t => {
  const f = await fixture(t);
  const initial = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => answer(payload));
  assert.equal(initial.skill_count, 2);
  const pointer = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  const request = { ...f.request, retrievalMode: 'model', _host_model: { provider: 'resumed-model', model: 'current-model', reasoningEffort: 'high' } };
  await assert.rejects(f.backend(request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id === 'csv-second') throw new Error('提取画像：csv-second：DSH 模型调用超时');
    return answer(payload);
  }), /csv-second.*超时/);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
  const resumed = [];
  const result = await f.backend(request, AbortSignal.timeout(20_000), async payload => { resumed.push(JSON.parse(payload.prompt)); return answer(payload); });
  assert.equal(result.cache_hits.profiles, 1);
  assert.equal(result.skill_count, 2);
  assert.deepEqual(resumed.filter(input => input.skill_id).map(input => input.skill_id), ['csv-second']);
});

test('malformed profile and relation shapes get one source-preserving format correction', async t => {
  const f = await fixture(t); const attempts = new Map(); const originalSources = new Map();
  const result = await f.backend({ ...f.request, retrievalMode: 'model' }, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    const key = input.skill_id || 'relation';
    const count = (attempts.get(key) || 0) + 1; attempts.set(key, count);
    if (input.skill_id && count === 1) originalSources.set(key, input.source);
    const valid = JSON.parse(answer(payload).content);
    if (count === 1 && key !== 'csv-second') {
      if (input.skill_id) valid.capability = valid.capability.text;
      else { valid.relations = valid.decision.relations; delete valid.decision; }
      return { content: JSON.stringify(valid) };
    }
    if (count === 2) {
      assert.match(payload.label, /格式纠正 1\/1/);
      assert.ok(input._format_correction.validation_errors.length > 0);
      assert.equal('input' in input._format_correction.validation_errors[0], false);
      if (input.skill_id) {
        assert.equal(input.source, originalSources.get(key));
        assert.equal(typeof JSON.parse(input._format_correction.previous_response).capability, 'string');
      }
    }
    return { content: JSON.stringify(valid) };
  });
  assert.equal(result.skill_count, 2); assert.equal(result.relation_counts.similar_to, 1);
  assert.deepEqual(Object.fromEntries(attempts), { 'csv-first': 2, 'csv-second': 1, relation: 2 });
});

test('repeated malformed objects stop after one correction and never enter a graph or cache', async t => {
  const f = await fixture(t);
  await f.backend(f.request, AbortSignal.timeout(20_000), async payload => answer(payload));
  const pointer = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  const request = { ...f.request, retrievalMode: 'model', _host_model: { provider: 'invalid-shape', model: 'current-model' } };
  const attempts = new Map();
  await assert.rejects(f.backend(request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt); attempts.set(input.skill_id, (attempts.get(input.skill_id) || 0) + 1);
    const value = JSON.parse(answer(payload).content); value.capability = 'invalid string';
    return { content: JSON.stringify(value) };
  }), error => /提取画像.*capability.*纠正一次后/.test(error.message) && !/pydantic\.dev|input_value/.test(error.message));
  assert.ok([...attempts.values()].every(count => count <= 2));
  assert.equal(attempts.get('csv-first'), 2);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
  const resumed = await f.backend(request, AbortSignal.timeout(20_000), async payload => answer(payload));
  assert.equal(resumed.cache_hits.profiles, 0);
});

test('format correction retains original source-line evidence checks', async t => {
  const f = await fixture(t); const attempts = new Map();
  await assert.rejects(f.backend({ ...f.request, retrievalMode: 'model' }, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt); const count = (attempts.get(input.skill_id) || 0) + 1; attempts.set(input.skill_id, count);
    const value = JSON.parse(answer(payload).content);
    if (count === 1) value.capability = 'needs format correction';
    else value.capability.evidence = [{ line: 999999 }];
    return { content: JSON.stringify(value) };
  }), /outside|行号/);
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
});

test('default model analysis publishes a readable graph without embeddings and shares validated SDK caches', async t => {
  const f = await fixture(t);
  const request = { ...f.request, _settings: {} }; delete request.retrievalMode;
  let calls = 0;
  const infer = async payload => { calls++; return answer(payload) };
  const run = request => f.backend(request, AbortSignal.timeout(20_000), infer);
  const result = await run(request);
  assert.equal(result.retrieval_mode, 'model');
  assert.equal(result.skill_count, 2); assert.equal(result.relation_counts.similar_to, 1);
  assert.equal(calls, 3); assert.equal(f.embeddings(), 0);
  const pointer = await readFile(join(request.indexPath, 'CURRENT'), 'utf8');
  const snapshot = join(request.indexPath, pointer.trim());
  const graph = JSON.parse(await readFile(join(snapshot, 'graph.json'), 'utf8'));
  assert.equal(graph.embedding_model, ''); assert.equal(graph.embedding_base_url, '');
  await assert.rejects(readFile(join(snapshot, 'embeddings.npz')), { code: 'ENOENT' });
  const local = await f.backend({ action: 'local-library', sourcePath: f.skills, indexPath: request.indexPath });
  assert.equal(local.analysisStatus, 'ready'); assert.equal(local.graph.relations.length, 1);
  assert.equal((await run(request)).cache_hits.relations, 1); assert.equal(calls, 3);
  const beforeFailure = await readFile(join(request.indexPath, 'CURRENT'), 'utf8');
  await assert.rejects(f.backend({ ...request, _host_model: { model: 'invalid-evidence' } }, AbortSignal.timeout(20_000), async payload => {
    const response = JSON.parse(answer(payload).content);
    if (response.capability) response.capability.evidence = [{ line: 9999 }];
    return { content: JSON.stringify(response) };
  }));
  assert.equal(await readFile(join(request.indexPath, 'CURRENT'), 'utf8'), beforeFailure);
  await assert.rejects(f.backend({ ...f.request, action: 'route', query: 'CSV' }, AbortSignal.timeout(20_000), infer), /不含向量索引/);
  // An explicit vector rebuild retains the original algorithm and reuses the
  // same valid profile/relation cache while adding real embeddings.
  const vector = await run(f.request);
  assert.equal(vector.cache_hits.profiles, 2); assert.equal(vector.cache_hits.relations, 1);
  assert.equal(calls, 3); assert.ok(f.embeddings() > 0);
});

test('default model routing explores current sources before any graph and keeps SDK ID validation', async t => {
  const f = await fixture(t);
  const request = { ...f.request, action: 'route', query: 'Process CSV rows', k: 1, _settings: {} }; delete request.retrievalMode;
  let wiki;
  const infer = async payload => {
    assert.equal(payload.method, 'explore');
    assert.match(payload.system, /read_wiki/); assert.match(payload.system, /JSON schema:/);
    assert.match(payload.prompt, /Process CSV rows/);
    wiki = payload.root;
    const index = await readFile(join(wiki, 'index.md'), 'utf8');
    assert.match(index, /csv-first/); assert.match(index, /csv-second/);
    assert.match(await readFile(join(wiki, 'sources/csv-first.md'), 'utf8'), /6: Process CSV rows/);
    assert.equal(await readFile(join(wiki, 'relations.json'), 'utf8'), '[]');
    return { content: JSON.stringify({ skills: [{ skill_id: 'csv-first', reason: '适合处理 CSV。' }] }) };
  };
  const result = await f.backend(request, AbortSignal.timeout(20_000), infer);
  assert.equal(result.skills[0].skill_id, 'csv-first'); assert.equal(result.skills[0].path, join(f.skills, 'csv-first'));
  assert.equal(Object.keys(result.source_versions).length, 2);
  assert.equal(f.embeddings(), 0);
  await assert.rejects(readFile(join(request.indexPath, 'CURRENT')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(wiki, 'index.md')), { code: 'ENOENT' });
  for (const selection of [
    [{ skill_id: 'invented', reason: 'No such source' }],
    [{ skill_id: 'csv-first', reason: 'CSV' }, { skill_id: 'csv-second', reason: 'CSV' }],
    [{ skill_id: 'csv-first', reason: 'CSV' }, { skill_id: 'csv-first', reason: 'CSV' }],
  ]) await assert.rejects(f.backend(request, AbortSignal.timeout(20_000), async () => ({ content: JSON.stringify({ skills: selection }) })));
  // Editing a source does not require reanalysis in this mode.
  await writeFile(join(f.skills, 'csv-first/SKILL.md'), '---\nname: csv-first\ndescription: Current version\n---\nUpdated source.\n');
  const updated = await f.backend(request, AbortSignal.timeout(20_000), async payload => {
    assert.match(await readFile(join(payload.root, 'sources/csv-first.md'), 'utf8'), /Updated source/);
    return { content: '{"skills":[]}' };
  });
  assert.notEqual(updated.source_versions['csv-first'], result.source_versions['csv-first']);
});

test('analysis cancellation stops a waiting host call without publishing an index', async t => {
  const f = await fixture(t); const controller = new AbortController();
  delete f.request.retrievalMode;
  let started; const ready = new Promise(resolve => { started = resolve; });
  const pending = f.backend(f.request, controller.signal, async (_payload, signal) => {
    started();
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const stopped = assert.rejects(pending);
  await ready; controller.abort(); await stopped;
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
});
