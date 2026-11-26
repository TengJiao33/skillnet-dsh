import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createBackend } from '../src/backend.js';

async function fixture(t, names = ['csv-first', 'csv-second']) {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-host-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'); await mkdir(skills);
  for (const name of names) {
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
      const output = [];
      if (typeof spec.stdio.stdin === 'object') {
        child.stdout.on('data', chunk => output.push(chunk));
        child.stdin.end(spec.stdio.stdin.data);
      }
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); });
      return { stdin: child.stdin, stdout: child.stdout, done,
        collected: { stdout: { readFrom: () => ({ text: Buffer.concat(output).toString('utf8'), lossy: false }) } },
        terminate: async () => { if (child.exitCode === null) child.kill() }, waitForExit: () => done };
    },
  });
  t.after(() => backend.dispose());
  const request = { action: 'analyze', retrievalMode: 'vector', sourcePath: skills, indexPath: join(root, 'index'), _host_model: { provider: 'fixture-a', model: 'current-model' }, _settings: { embedding_api_key: 'fixture-vector-key', embedding_base_url: `http://127.0.0.1:${server.address().port}/v1`, embedding_model: 'fixture-vector' } };
  return { root, skills, backend, request, embeddings: () => embeddingCalls };
}

function related(first, second, type = 'similar_to') {
  return { outcome: 'related', relations: [{ source: first.skill_id, target: second.skill_id, type, contexts: [{ scenario: 'CSV rows', explanation: 'Both process CSV rows.', conditions: [], source_evidence: [{ line: 6 }], target_evidence: [{ line: 6 }] }] }] };
}

function decisionLines(anchor, candidates, decide = related) {
  return candidates.map(candidate => JSON.stringify({ candidate: candidate.skill_id, decision: decide(anchor, candidate) })).join('\n');
}

function answer(payload) {
  const input = JSON.parse(payload.prompt);
  if (input.skill_id) return { content: JSON.stringify({ capability: { text: 'CSV processing ' + input.skill_id, evidence: [{ line: 6 }] }, when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] }) };
  if (input.anchor) return { content: decisionLines(input.anchor, input.candidates) };
  return { content: JSON.stringify({ decision: related(...input.skills) }) };
}

test('stock analysis uses DSH for profiles and relations, keeps indexes/cache, and partitions selected models', async t => {
  const f = await fixture(t); const seen = [];
  const infer = async payload => { seen.push(payload); assert.equal(payload.method, 'chat'); assert.equal(payload.timeout_ms, 600_000); assert.match(payload.label, /^(提取画像|判断关系)：csv-/); assert.match(payload.system, /JSON schema:/); assert.equal(payload.phase, JSON.parse(payload.prompt).skill_id ? 'profile' : 'relation'); await setTimeout(20); return answer(payload); };
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

test('analysis keeps two model requests in flight and matches out-of-order replies', async t => {
  const f = await fixture(t);
  await mkdir(join(f.skills, 'csv-third'));
  await writeFile(join(f.skills, 'csv-third', 'SKILL.md'), '---\nname: csv-third\ndescription: Process CSV rows\n---\n# CSV\nProcess CSV rows.\n');
  const firstStarted = Promise.withResolvers(), thirdStarted = Promise.withResolvers();
  const completed = [];
  let active = 0, peak = 0;
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async (payload, signal) => {
    const { skill_id } = JSON.parse(payload.prompt);
    if (!skill_id) return answer(payload);
    active++;
    peak = Math.max(peak, active);
    try {
      if (skill_id === 'csv-first') {
        firstStarted.resolve();
        await Promise.race([
          thirdStarted.promise,
          setTimeout(3000, undefined, { signal, ref: false }).then(() => assert.fail('An available slot never started the third profile')),
        ]);
      }
      if (skill_id === 'csv-second') await firstStarted.promise;
      if (skill_id === 'csv-third') thirdStarted.resolve();
      completed.push(skill_id);
      return answer(payload);
    } finally { active--; }
  });
  assert.equal(peak, 2);
  assert.deepEqual(completed, ['csv-second', 'csv-third', 'csv-first']);
  const current = (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim();
  const graph = JSON.parse(await readFile(join(f.request.indexPath, current, 'graph.json'), 'utf8'));
  assert.equal(result.skill_count, 3);
  for (const skill of graph.skills) assert.equal(skill.profile.capability.text, 'CSV processing ' + skill.skill_id);
});

test('vector analysis batches at most four candidates, keeps two requests in flight, and judges every pair', async t => {
  const names = ['csv-a', 'csv-b', 'csv-c', 'csv-d', 'csv-e'];
  const f = await fixture(t, names);
  const covered = [], directed = [], batchSizes = [];
  const twoStarted = Promise.withResolvers();
  let active = 0, peak = 0;
  const run = infer => f.backend(f.request, AbortSignal.timeout(20_000), infer);
  const result = await run(async (payload, signal) => {
    const input = JSON.parse(payload.prompt);
    if (!input.anchor) {
      if (input.skills) covered.push(input.skills.map(skill => skill.skill_id).sort().join(','));
      return answer(payload);
    }
    batchSizes.push(input.candidates.length);
    assert.ok(input.candidates.length >= 2 && input.candidates.length <= 4);
    assert.equal(payload.expect_json, true);
    assert.equal(payload.phase, 'relation');
    assert.match(payload.label, /批量判断关系/);
    assert.equal(input.candidates.some(skill => skill.skill_id === input.anchor.skill_id), false);
    const schema = JSON.parse(payload.system.split('\nJSON schema for each line:\n').at(-1));
    assert.deepEqual(schema.properties.candidate.enum, input.candidates.map(skill => skill.skill_id));
    for (const candidate of input.candidates) {
      assert.match(candidate.source, /6: Process CSV rows/);
      assert.ok(candidate.retrieval_hints.length);
      covered.push([input.anchor.skill_id, candidate.skill_id].sort().join(','));
      directed.push([candidate.skill_id, input.anchor.skill_id].join(','));
    }
    active++;
    peak = Math.max(peak, active);
    if (active === 2) twoStarted.resolve();
    try {
      await Promise.race([twoStarted.promise, setTimeout(3000, undefined, { signal, ref: false }).then(() => assert.fail('Second relation request did not start'))]);
      return { content: decisionLines(input.anchor, input.candidates, (anchor, candidate) => related(candidate, anchor, 'compose_with')) };
    } finally { active--; }
  });
  assert.equal(peak, 2);
  assert.deepEqual(batchSizes.sort(), [2, 3, 4]);
  assert.deepEqual(covered.sort(), names.flatMap((first, i) => names.slice(i + 1).map(second => `${first},${second}`)));
  assert.deepEqual(result.relation_counts, { compose_with: 9, similar_to: 1 });
  assert.equal(result.cache_hits.relations, 0);
  const snapshot = (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim();
  const graph = JSON.parse(await readFile(join(f.request.indexPath, snapshot, 'graph.json'), 'utf8'));
  assert.deepEqual(graph.relations.filter(edge => edge.type === 'compose_with').map(edge => `${edge.source},${edge.target}`).sort(), directed.sort());
  const resumed = await run(async () => assert.fail('A validated pair or profile was sent again'));
  assert.equal(resumed.cache_hits.relations, 10);

  const cached = await readFile(join(f.request.indexPath, 'cache.sqlite'));
  const sample = { snapshot: (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim(),
    pairs: names.slice(1).map(name => ({ skills: [names[0], name], hints: ['sample'] })) };
  let batchCalls = 0;
  const retried = [];
  const report = await f.backend({ action: 'review-sample', indexPath: f.request.indexPath, sample,
    _host_model: f.request._host_model }, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.anchor) {
      batchCalls++;
      const complete = decisionLines(input.anchor, input.candidates.filter(skill => skill.skill_id !== 'csv-d'),
        () => ({ outcome: 'none', reason: '示例' }));
      return { content: complete + '\n{"candidate":"csv-d","decision":', truncated: true };
    }
    retried.push(input.skills.map(skill => skill.skill_id));
    return answer(payload);
  });
  assert.equal(batchCalls, 1);
  assert.deepEqual(retried, [['csv-a', 'csv-d']]);
  assert.equal(report.completed, 4);
  assert.equal(report.pairs.filter(row => row.decision.outcome === 'none').length, 3);
  assert.ok(report.pairs.every(row => row.reference_relations.length === 1));
  assert.deepEqual(await readFile(join(f.request.indexPath, 'cache.sqlite')), cached);
  assert.equal((await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim(), sample.snapshot);
});

test('a source edit during background analysis leaves the current SDK snapshot in place', async t => {
  const f = await fixture(t);
  const signal = AbortSignal.timeout(20_000);
  await f.backend(f.request, signal, async payload => answer(payload));
  const pointer = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  const changedModel = { ...f.request, _host_model: { ...f.request._host_model, model: 'different-model' } };
  await assert.rejects(f.backend(changedModel, signal, async payload => {
    const { skill_id } = JSON.parse(payload.prompt);
    if (skill_id === 'csv-first') await writeFile(join(f.skills, skill_id, 'SKILL.md'), '---\nname: csv-first\ndescription: Updated CSV source\n---\n# Updated\nReview new CSV content.\n');
    return answer(payload);
  }), /源码已改变/);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
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
    value.profile_note = 'An extra key must not hide a malformed required field.';
    return { content: JSON.stringify(value) };
  }), error => /提取画像.*capability.*纠正一次后/.test(error.message) && !/pydantic\.dev|input_value/.test(error.message));
  assert.ok([...attempts.values()].every(count => count <= 2));
  assert.equal(attempts.get('csv-first'), 2);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
  const resumed = await f.backend(request, AbortSignal.timeout(20_000), async payload => answer(payload));
  assert.equal(resumed.cache_hits.profiles, 0);
});

test('profile validation failures drain the phase and vector analysis resumes only missing profiles', async t => {
  const f = await fixture(t, ['csv-first', 'csv-second', 'csv-third', 'csv-fourth']);
  const run = infer => f.backend(f.request, AbortSignal.timeout(20_000), infer);
  const seen = new Map();
  const partial = await run(async payload => {
    assert.equal(payload.expect_json, true);
    const input = JSON.parse(payload.prompt);
    const id = input.skill_id;
    if (!id) return answer(payload);
    const attempt = (seen.get(id) || 0) + 1;
    seen.set(id, attempt);
    if (id === 'csv-first') {
      const value = JSON.parse(answer(payload).content);
      if (attempt === 2) {
        assert.match(input._format_correction.validation_errors[0].message, /capability\.evidence.*1\.\.6/);
      }
      value.capability.evidence[0].line = 7;
      return { content: JSON.stringify(value) };
    }
    if (id === 'csv-second') {
      if (attempt === 2) assert.match(input._format_correction.validation_errors[0].message, /空文本/);
      return { content: ' \n ' };
    }
    return { content: ['```JSON', answer(payload).content, '```'].join('\n') };
  });
  assert.deepEqual(partial.pending_profiles.sort(), ['csv-first', 'csv-second']);
  assert.equal(partial.skill_count, 2);
  const local = () => f.backend({ action: 'local-library', sourcePath: f.skills, indexPath: f.request.indexPath });
  const state = await local();
  assert.equal(state.addedSkills, 0);
  assert.deepEqual(state.pendingProfiles.sort(), ['csv-first', 'csv-second']);
  const pendingPath = join(f.skills, 'csv-first', 'SKILL.md');
  const original = await readFile(pendingPath, 'utf8');
  await writeFile(pendingPath, original + 'Source changed after snapshot.\n');
  assert.equal((await local()).addedSkills, 1);
  await writeFile(pendingPath, original);
  assert.deepEqual(Object.fromEntries(seen), { 'csv-first': 2, 'csv-fourth': 1, 'csv-second': 2, 'csv-third': 1 });
  assert.ok(f.embeddings() > 0);
  const resumed = [];
  const result = await run(async payload => {
    const { skill_id } = JSON.parse(payload.prompt);
    if (skill_id) resumed.push(skill_id);
    return answer(payload);
  });
  assert.deepEqual(resumed.sort(), ['csv-first', 'csv-second']);
  assert.equal(result.cache_hits.profiles, 2);
  assert.equal(result.skill_count, 4);
  assert.equal(result.cache_hits.relations, 1);
  assert.deepEqual(result.pending_profiles, []);
});

test('the original canvas-design response publishes on the first attempt with only in-range evidence', async t => {
  const f = await fixture(t, ['canvas-design', 'csv-other']);
  const path = join(f.skills, 'canvas-design', 'SKILL.md');
  await writeFile(path, await readFile(path, 'utf8') + 'fixture line\n'.repeat(124));
  const content = await readFile(new URL('./fixtures/canvas-design-profile.json', import.meta.url), 'utf8');
  let calls = 0;
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id !== 'canvas-design') return answer(payload);
    calls++;
    return { content };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.pending_profiles, []);
  const state = await f.backend({ action: 'local-library', sourcePath: f.skills, indexPath: f.request.indexPath });
  const profile = state.graph.skills.find(s => s.skill_id === 'canvas-design').profile;
  assert.deepEqual(profile.outputs[1].evidence, [{ line: 106 }]);
  assert.deepEqual(profile.scenarios[2].after, []);
  assert.deepEqual(profile.capability, JSON.parse(content).capability);
});

test('an isolated relation failure publishes a partial graph after one last attempt', async t => {
  const f = await fixture(t, ['csv-first', 'csv-second', 'csv-third']);
  const request = { ...f.request, retrievalMode: 'model' };
  const run = (args, infer) => f.backend(args, AbortSignal.timeout(20_000), infer);
  const current = join(request.indexPath, 'CURRENT');
  await run(request, async payload => answer(payload));
  const previous = await readFile(current, 'utf8');
  const retryable = { ...request, _host_model: { ...request._host_model, model: 'relation-retry' } };
  const failedPair = 'csv-first,csv-second';
  const seen = new Map();
  let batches = 0;
  const partial = await run(retryable, async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id) return answer(payload);
    if (input.anchor) {
      batches++;
      const decisions = Object.fromEntries(input.candidates.map(candidate => {
        const pair = [input.anchor.skill_id, candidate.skill_id].sort().join(',');
        if (pair !== failedPair) return [candidate.skill_id, { outcome: 'none', reason: '证据不足' }];
        return [candidate.skill_id, related(input.anchor, { skill_id: 'csv-third' })];
      }));
      return { content: JSON.stringify({ decisions }).slice(0, -1) };
    }
    const pair = input.skills.map(skill => skill.skill_id).join(',');
    assert.equal(payload.phase, 'relation');
    const attempt = (seen.get(pair) || 0) + 1;
    seen.set(pair, attempt);
    if (pair === failedPair) {
      if (attempt === 2) assert.match(input._format_correction.validation_errors[0].message, /长度上限/);
      return { ...answer(payload), truncated: true };
    }
    return { content: '{"decision":{"outcome":"none","reason":"证据不足"}}' };
  });
  assert.equal(partial.pending_relations, 1);
  assert.equal(batches, 1);
  assert.equal(seen.get(failedPair), 3);
  assert.equal(seen.size, 2);
  assert.equal([...seen.values()].reduce((sum, count) => sum + count, 0), 4);
  assert.notEqual(await readFile(current, 'utf8'), previous);
  const resumed = [];
  const result = await run(retryable, async payload => {
    const input = JSON.parse(payload.prompt);
    resumed.push(input.skills.map(skill => skill.skill_id).join(','));
    return answer(payload);
  });
  assert.deepEqual(resumed, [failedPair]);
  assert.deepEqual(result.cache_hits, { profiles: 3, relations: 2, embeddings: 0 });
  assert.equal(result.relation_counts.similar_to, 1);
  assert.notEqual(await readFile(current, 'utf8'), previous);
});

test('relation review restores one missing closing brace and still checks the cited lines', async t => {
  const f = await fixture(t, ['csv-first', 'csv-second', 'csv-third']);
  let pairWithBadCitation;
  const singlePairs = [];
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id) return answer(payload);
    if (input.anchor) {
      const [first, second] = input.candidates;
      pairWithBadCitation = [input.anchor.skill_id, second.skill_id].sort().join(',');
      const rejected = related(input.anchor, second);
      rejected.relations[0].contexts[0].source_evidence[0].line = 999;
      const rows = [
        { candidate: first.skill_id, decision: related(input.anchor, first) },
        { candidate: second.skill_id, decision: rejected },
      ];
      return { content: rows.map(row => JSON.stringify(row).slice(0, -1)).join('\n') };
    }
    assert.equal(input._format_correction, undefined);
    singlePairs.push(input.skills.map(skill => skill.skill_id).sort().join(','));
    return { content: answer(payload).content.slice(0, -1) };
  });
  assert.ok(pairWithBadCitation);
  assert.equal(singlePairs.length, 2);
  assert.ok(singlePairs.includes(pairWithBadCitation));
  assert.equal(result.relation_counts.similar_to, 3);
});

test('relation review discards unknown union fields without a new model request', async t => {
  const f = await fixture(t, ['csv-first', 'csv-second', 'csv-third']);
  let relationCalls = 0;
  const decision = (first, second) => {
    const value = related(first, second);
    value.relations[0].contexts_note = 'extra field in the related branch';
    value.relations[0].contexts[0].source_evidence = { line: '6' };
    return value;
  };
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id) return answer(payload);
    assert.equal(input._format_correction, undefined);
    relationCalls++;
    if (input.anchor) {
      return { content: input.candidates.map(candidate => JSON.stringify({
        candidate: candidate.skill_id,
        decision: decision(input.anchor, candidate),
        note: 'extra field outside the decision',
      })).join('\n') };
    }
    return { content: JSON.stringify({ decision: decision(...input.skills), relations: [] }) };
  });
  assert.equal(relationCalls, 2);
  assert.equal(result.relation_counts.similar_to, 3);
});

test('publishes a usable snapshot and resumes the one missing decision out of 28', async t => {
  const names = Array.from({ length: 8 }, (_, i) => 'csv-' + i);
  const f = await fixture(t, names);
  const bad = (a, b) => [a.skill_id, b.skill_id].sort().join(',') === 'csv-0,csv-1';
  const first = await f.backend(f.request, AbortSignal.timeout(30_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.anchor) return { content: decisionLines(input.anchor, input.candidates,
      (a, b) => bad(a, b) ? {} : related(a, b)) };
    if (input.skills && bad(...input.skills)) return { content: '{}' };
    return answer(payload);
  });
  assert.equal(first.candidate_pairs, 28);
  assert.equal(first.pending_relations, 1);
  assert.equal(first.relation_counts.similar_to, 27);
  const targeted = { ...f.request, retrySnapshot: first.snapshot };
  let rejectedCalls = 0;
  const stillPending = await f.backend(targeted, AbortSignal.timeout(20_000), async payload => {
    assert.ok(bad(...JSON.parse(payload.prompt).skills));
    rejectedCalls++;
    return { content: '{}' };
  });
  assert.equal(rejectedCalls, 1);
  assert.equal(stillPending.pending_relations, 1);
  assert.equal(stillPending.snapshot, first.snapshot);
  const resumed = await f.backend(targeted, AbortSignal.timeout(20_000), async payload => {
    assert.ok(bad(...JSON.parse(payload.prompt).skills));
    return answer(payload);
  });
  assert.equal(resumed.pending_relations, 0);
  assert.deepEqual(resumed.cache_hits, { profiles: 0, relations: 0, embeddings: 0 });
  assert.equal(resumed.retried_candidates, 1);
  assert.equal(resumed.model_calls.relation, 1);
  assert.deepEqual(await readFile(join(f.request.indexPath, first.snapshot, 'embeddings.npz')),
    await readFile(join(f.request.indexPath, resumed.snapshot, 'embeddings.npz')));
  await assert.rejects(f.backend(targeted, AbortSignal.timeout(20_000), () => assert.fail('stale retry')), /图谱已有更新/);
  assert.equal(resumed.relation_counts.similar_to, 28);
});

test('a fresh final judgment closes the remaining pair before publishing', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c']);
  const progress = [];
  const singles = [];
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.anchor) return { content: decisionLines(input.anchor, input.candidates,
      (a, b) => b.skill_id === 'csv-b' ? {} : related(a, b)) };
    if (input.skills && input.skills.some(s => s.skill_id === 'csv-a') && input.skills.some(s => s.skill_id === 'csv-b')) {
      singles.push(payload.label);
      if (!payload.label.startsWith('复核剩余')) return { content: '{}' };
    }
    return answer(payload);
  }, message => progress.push(message));
  assert.equal(singles.length, 3);
  assert.deepEqual(progress, ['正在复核剩余 1 对候选']);
  assert.equal(result.pending_relations, 0);
  assert.equal(result.relation_counts.similar_to, 3);
  assert.equal(result.cache_hits.relations, 0);
  const config = JSON.parse(await readFile(join(f.request.indexPath, result.snapshot, 'analysis-config.json')));
  assert.equal(config.pending_pairs, undefined);
});

test('host bridge admits four simultaneous profile requests for the adaptive pacer', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c', 'csv-d']);
  const ready = Promise.withResolvers();
  let inFlight = 0;
  await f.backend({ ...f.request, max_workers: 4 }, AbortSignal.timeout(20_000), async payload => {
    if (payload.phase === 'profile') {
      if (++inFlight === 4) ready.resolve();
      await ready.promise;
      inFlight--;
    }
    return answer(payload);
  });
});

test('legacy screen flags still review all candidates and reuse their judgments', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c']);
  const run = request => f.backend(request, AbortSignal.timeout(20_000), async payload => {
    assert.notEqual(payload.format, 'screen-lines');
    return answer(payload);
  });
  const first = await run({ ...f.request, screenCandidates: true });
  assert.equal(first.candidate_pairs, 3);
  assert.equal(first.screened_out, 0);
  assert.equal(first.relation_counts.similar_to, 3);
  const full = await run(f.request);
  assert.equal(full.cache_hits.profiles, 3);
  assert.equal(full.cache_hits.relations, 3);
});

test('direct API builds through the common pipeline and falls back on explicit unsupported schema', async t => {
  const f = await fixture(t, ['csv-first', 'csv-second', 'csv-third']);
  const formats = [];
  let missingPair, attempts = 0;
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    formats.push(body.response_format?.type);
    res.setHeader('content-type', 'application/json');
    if (body.response_format?.type === 'json_schema') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'unsupported response_format json_schema' } }));
      return;
    }
    const prompt = body.messages.at(-1).content;
    const input = JSON.parse(prompt);
    let output;
    if (input.anchor) {
      missingPair = [input.anchor.skill_id, input.candidates[0].skill_id].sort().join(',');
      output = { content: JSON.stringify({ decisions: Object.fromEntries(input.candidates.map((c, i) =>
        [c.skill_id, i === 0 ? {} : related(input.anchor, c)])) }) };
    } else if (input.skills && input.skills.map(s => s.skill_id).sort().join(',') === missingPair && ++attempts <= 2) {
      output = { content: '{}' };
    } else {
      output = answer({ prompt });
    }
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output.content } }] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const request = { ...f.request, retrievalMode: 'model', _host_model: undefined,
    _settings: { api_key: 'fixture', model: 'fixture', base_url: `http://127.0.0.1:${api.address().port}/v1`, json_mode: 'auto' } };
  const progress = [];
  const result = await f.backend(request, AbortSignal.timeout(20_000), undefined, message => progress.push(message));
  assert.deepEqual(progress, ['正在复核剩余 1 对候选']);
  assert.equal(attempts, 3);
  assert.equal(result.pending_relations, 0);
  assert.equal(result.relation_counts.similar_to, 3);
  assert.ok(formats.includes('json_schema'));
  assert.equal(formats.filter(value => value === 'json_object').length, 8);
});

test('an oversized batch falls back to single pairs without dropping candidates', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c']);
  const seen = [];
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.anchor) {
      seen.push('batch');
      throw new Error('context_length_exceeded');
    }
    if (input.skills) seen.push(input.skills.map(skill => skill.skill_id).join(','));
    return answer(payload);
  });
  assert.deepEqual(seen.sort(), ['batch', 'csv-a,csv-b', 'csv-a,csv-c', 'csv-b,csv-c']);
  assert.equal(result.relation_counts.similar_to, 3);
  assert.equal(result.cache_hits.relations, 0);
});

test('an otherwise valid profile drops unexpected scenario and profile notes without another model call', async t => {
  const f = await fixture(t);
  let profileCalls = 0;
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    const value = JSON.parse(answer(payload).content);
    if (input.skill_id) {
      profileCalls++;
      value.scenarios = [{
        name: 'Review CSV rows',
        before: [{ text: 'Has CSV rows', evidence: [{ line: 6 }] }],
        after: [{ text: 'Findings reported', evidence: [{ line: 6 }] }],
        scenarios_note: 'Unexpected model commentary.',
      }];
      value.profile_note = 'Extra profile commentary.';
    }
    return { content: JSON.stringify(value) };
  });
  assert.equal(result.skill_count, 2);
  assert.equal(profileCalls, 2);
  const current = (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim();
  const graph = JSON.parse(await readFile(join(f.request.indexPath, current, 'graph.json'), 'utf8'));
  for (const { profile } of graph.skills) {
    assert.equal('profile_note' in profile, false);
    assert.deepEqual(profile.scenarios, [{
      name: 'Review CSV rows',
      before: [{ text: 'Has CSV rows', evidence: [{ line: 6 }] }],
      after: [{ text: 'Findings reported', evidence: [{ line: 6 }] }],
    }]);
  }
});

test('format correction retains original source-line evidence checks', async t => {
  const f = await fixture(t); const attempts = new Map();
  await assert.rejects(f.backend({ ...f.request, retrievalMode: 'model' }, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt); const count = (attempts.get(input.skill_id) || 0) + 1; attempts.set(input.skill_id, count);
    const value = JSON.parse(answer(payload).content);
    if (count === 1) value.capability = 'needs format correction';
    else {
      value.capability.evidence = [{ line: 999999 }];
      value.profile_note = 'Removing extras must leave source evidence validation intact.';
    }
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
    const prompt = JSON.parse(payload.prompt);
    assert.equal(prompt.task, 'Process CSV rows');
    assert.deepEqual(prompt.candidates.map(candidate => candidate.id), ['csv-first', 'csv-second']);
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
  const ready = Promise.withResolvers();
  let started = 0, cancelled = 0;
  const pending = f.backend(f.request, controller.signal, async (_payload, signal) => {
    if (++started === 2) ready.resolve();
    return new Promise((_resolve, reject) => {
      const abort = () => { cancelled++; reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  });
  const stopped = assert.rejects(pending);
  await Promise.race([ready.promise, setTimeout(15_000, undefined, { ref: false }).then(() => controller.abort())]);
  controller.abort();
  await stopped;
  assert.equal(started, 2);
  assert.equal(cancelled, 2);
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
});

test('relation requests ask only for the decision and cache SDK judgments', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c']);
  const forms = new Set();
  const result = await f.backend(f.request, AbortSignal.timeout(20_000), async payload => {
    const input = JSON.parse(payload.prompt);
    if (input.skill_id) return answer(payload);
    forms.add(input.anchor ? 'batch' : 'single');
    const schema = JSON.parse(payload.system.split(input.anchor ? '\nJSON schema for each line:\n' : '\nJSON schema:\n').at(-1));
    const fields = input.anchor ? ['candidate', 'decision'] : ['decision'];
    assert.deepEqual(Object.keys(schema.properties), fields);
    assert.deepEqual(schema.required, fields);
    assert.doesNotMatch(payload.system, /\bbrief\b/);
    return answer(payload);
  });
  assert.deepEqual(forms, new Set(['batch', 'single']));
  assert.equal(result.pending_relations, 0);
  const current = (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim();
  const graph = JSON.parse(await readFile(join(f.request.indexPath, current, 'graph.json'), 'utf8'));
  assert.equal(graph.relations.length, 3);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(f.request.indexPath, 'cache.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare("SELECT value FROM results WHERE namespace='relation'").all();
    assert.equal(rows.length, 3);
    const decisions = rows.map(row => JSON.parse(row.value));
    assert.ok(decisions.every(value => Object.keys(value).join() === 'decision'));
  } finally { database.close(); }
});

test('direct strict schemas accept single and mapped batch decisions without briefs', async t => {
  const f = await fixture(t, ['csv-a', 'csv-b', 'csv-c']);
  const seen = [];
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const prompt = body.messages.at(-1).content;
    const input = JSON.parse(prompt);
    const format = body.response_format?.json_schema;
    let content;
    if (input.anchor) {
      const schemas = format.schema.properties.decisions.properties;
      seen.push(...Object.values(schemas).map(schema => ['batch', format.strict, schema]));
      content = JSON.stringify({ decisions: Object.fromEntries(input.candidates.map(c => [
        c.skill_id, related(input.anchor, c),
      ])) });
    } else if (input.skills) {
      seen.push(['single', format.strict, format.schema]);
      content = JSON.stringify({ decision: related(...input.skills) });
    } else content = answer({ prompt }).content;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const request = { ...f.request, retrievalMode: 'model', _host_model: undefined,
    _settings: { api_key: 'fixture', model: 'fixture', base_url: `http://127.0.0.1:${api.address().port}/v1`, json_mode: 'on' } };
  const result = await f.backend(request, AbortSignal.timeout(20_000));
  assert.equal(result.relation_counts.similar_to, 3);
  assert.deepEqual(seen.map(([mode]) => mode).sort(), ['batch', 'batch', 'single']);
  for (const [mode, strict, schema] of seen) {
    assert.equal(strict, true);
    if (mode === 'batch') assert.deepEqual(schema, { $ref: '#/$defs/PairDecision' });
    else {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(Object.keys(schema.properties), ['decision']);
      assert.deepEqual(schema.required, ['decision']);
    }
  }
});
