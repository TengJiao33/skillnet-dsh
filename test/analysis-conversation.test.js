import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createBackend, pythonExecutable } from '../src/backend.js';
import { createAnalysisConversation } from '../src/analysis-conversation.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-conversation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'); await mkdir(skills);
  for (const name of ['csv-first', 'csv-second']) {
    await mkdir(join(skills, name));
    await writeFile(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Process CSV rows\n---\n# CSV\nProcess CSV rows and report findings.\n`);
  }
  const backend = createBackend({
    resolveExecutable: async value => value,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env, SKILLNET_CONFIG: join(root, 'config.json') }, stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal });
      child.stderr.resume();
      let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
      if (spec.stdio.stdin?.data) child.stdin.end(spec.stdio.stdin.data);
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); });
      return { stdin: child.stdin, stdout: child.stdout, collected: { stdout: { readFrom: () => ({ text: output, lossy: false }) } }, done, terminate: async () => { if (child.exitCode === null) child.kill(); }, waitForExit: () => done };
    },
  });
  t.after(() => backend.dispose());
  const request = { action: 'analysis-step', sourcePath: skills, indexPath: join(root, 'index'), runPath: join(root, 'run'), modelSelection: { provider: 'fixture', model: 'current', reasoningEffort: 'high' } };
  const step = args => backend({ ...request, ...args }, AbortSignal.timeout(20_000));
  return { root, skills, request, step };
}
function answer(task) {
  if (task.kind === 'profile') return { capability: { text: 'CSV processing ' + task.payload.skill_id, evidence: [{ line: 6 }] }, when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] };
  const [first, second] = task.payload.skills;
  return { decision: { outcome: 'related', relations: [{ source: first.skill_id, target: second.skill_id, type: 'similar_to', contexts: [{ scenario: 'CSV rows', explanation: 'Both process CSV rows.', conditions: [], source_evidence: [{ line: 6 }], target_evidence: [{ line: 6 }] }] }] } };
}
async function finish(f, value) {
  while (value.status !== 'completed') value = await f.step({ stepId: value.task.stepId, result: answer(value.task) });
  return value;
}

test('native graph steps survive process restart, retain SDK prompts/schema and publish only after every validation', async t => {
  const f = await fixture(t);
  // Every backend call starts a fresh Python worker, exercising on-disk resume.
  const first = await f.step();
  assert.equal(first.status, 'awaiting_result');
  assert.equal(first.task.payload.skill_id, 'csv-first');
  assert.match(first.task.payload.source, /6.*Process CSV rows/);
  assert.ok(first.task.schema.properties.capability.$ref);
  const prompts = JSON.parse(spawnSync(pythonExecutable(), ['-c', 'import json; from skillnet_ai.core.prompts import PROFILE_PROMPT, RELATION_PROMPT; print(json.dumps([PROFILE_PROMPT, RELATION_PROMPT]))'], { encoding: 'utf8' }).stdout);
  assert.equal(first.task.system, prompts[0]);
  const initialState = JSON.parse(await readFile(join(f.request.runPath, 'analysis.json')));
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
  const next = await f.step({ stepId: first.task.stepId, result: answer(first.task) });
  assert.equal(next.progress.profiles, 1);
  const resumed = await f.step();
  assert.deepEqual(resumed.task, next.task);
  const replay = await f.step({ stepId: first.task.stepId, result: answer(first.task) });
  assert.deepEqual(replay.task, next.task);
  const relation = await f.step({ stepId: next.task.stepId, result: answer(next.task) });
  assert.equal(relation.task.kind, 'relation');
  assert.equal(relation.task.system, prompts[1]);
  assert.ok(relation.task.schema.properties.decision.anyOf);
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
  const result = await finish(f, relation);
  assert.equal(result.result.skill_count, 2);
  assert.equal(result.result.relation_counts.similar_to, 1);
  const pointer = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  assert.ok(initialState.stage.endsWith(pointer.trim()));
  const graph = JSON.parse(await readFile(join(f.request.indexPath, pointer.trim(), 'graph.json'), 'utf8'));
  assert.equal(graph.skills.length, 2); assert.equal(graph.relations.length, 1);
  const again = await f.step(); assert.deepEqual(again, result);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
  // A new run reuses the exact original successful-result cache keys.
  const cached = await f.step({ runPath: join(f.root, 'run-cached') });
  assert.equal(cached.status, 'completed');
  assert.equal(cached.result.cache_hits.profiles, 2); assert.equal(cached.result.cache_hits.relations, 1);
});

test('malformed shape, bad source evidence and invented endpoints remain pending and cannot replace the old graph', async t => {
  const f = await fixture(t); await finish(f, await f.step());
  const pointer = await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8');
  const changes = { runPath: join(f.root, 'new-run'), modelSelection: { provider: 'another-model', model: 'current' } };
  const call = args => f.step({ ...changes, ...args });
  let value = await call({});
  let invalid = await call({ stepId: value.task.stepId, result: { ...answer(value.task), capability: 'invalid string' } });
  assert.equal(invalid.status, 'needs_correction'); assert.equal(invalid.progress.profiles, 0);
  assert.deepEqual(invalid.task, value.task);
  invalid = await call({ stepId: value.task.stepId, result: { ...answer(value.task), capability: { text: 'invented', evidence: [{ line: 99999 }] } } });
  assert.equal(invalid.status, 'needs_correction'); assert.equal(invalid.progress.profiles, 0);
  value = await call({ stepId: value.task.stepId, result: answer(value.task) });
  value = await call({ stepId: value.task.stepId, result: answer(value.task) });
  const badRelation = answer(value.task); badRelation.decision.relations[0].source = 'not-a-candidate';
  invalid = await call({ stepId: value.task.stepId, result: badRelation });
  assert.equal(invalid.status, 'needs_correction'); assert.equal(invalid.progress.relations, 0);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), pointer);
  const resumed = await call({}); assert.equal(resumed.task.stepId, value.task.stepId);
});

test('source/model changes, stale steps and missing explicit vector configuration do not silently change analysis', async t => {
  const f = await fixture(t); const first = await f.step();
  await assert.rejects(f.step({ modelSelection: { provider: 'other', model: 'current' } }), /模型或建图模式已改变/);
  await assert.rejects(f.step({ stepId: 'profile:unknown', result: {} }), /步骤已过期/);
  await assert.rejects(f.step({ retrievalMode: 'vector', runPath: join(f.root, 'vector') }), /Missing embedding settings/);
  await writeFile(join(f.skills, 'csv-first', 'SKILL.md'), '---\nname: csv-first\ndescription: changed\n---\nNew source\n');
  await assert.rejects(f.step({ stepId: first.task.stepId, result: answer(first.task) }), /源码已改变/);
  await assert.rejects(readFile(join(f.request.indexPath, 'CURRENT')), { code: 'ENOENT' });
});

test('a concurrent newer graph prevents stale publication', async t => {
  const f = await fixture(t); let value = await f.step();
  value = await f.step({ stepId: value.task.stepId, result: answer(value.task) });
  value = await f.step({ stepId: value.task.stepId, result: answer(value.task) });
  await writeFile(join(f.request.indexPath, 'CURRENT'), 'newer-snapshot\n');
  await assert.rejects(f.step({ stepId: value.task.stepId, result: answer(value.task) }), /更新的图谱/);
  assert.equal(await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8'), 'newer-snapshot\n');
});

test('explicit vector steps retain SDK embeddings, candidate judgments and the published vector index', async t => {
  const f = await fixture(t); let embeddings = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); embeddings++;
    assert.equal(req.url, '/v1/embeddings');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: input.input.map((_text, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })), model: 'fixture-vector' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  Object.assign(f.request, { retrievalMode: 'vector', _settings: { embedding_api_key: 'fixture-only', embedding_model: 'fixture-vector', embedding_base_url: `http://127.0.0.1:${server.address().port}/v1` } });
  const result = await finish(f, await f.step());
  assert.ok(embeddings > 0); assert.equal(result.result.retrieval_mode, 'vector');
  const snapshot = (await readFile(join(f.request.indexPath, 'CURRENT'), 'utf8')).trim();
  const graph = JSON.parse(await readFile(join(f.request.indexPath, snapshot, 'graph.json'), 'utf8'));
  assert.equal(graph.embedding_model, 'fixture-vector');
  assert.equal(graph.relations.length, 1);
  await readFile(join(f.request.indexPath, snapshot, 'embeddings.npz'));
});

test('preparing a graph conversation creates only a fresh user session and draft, without a job, backend call or global model change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-graph-draft-')); t.after(() => rm(root, { recursive: true, force: true }));
  const selection = { provider: 'fixture', model: 'current', reasoningEffort: 'high' }, calls = [], agents = new Map(); let guard;
  const item = { id: 'connected-library', name: '个人库', sourcePath: root, indexPath: join(root, '.skillnet') };
  const ctx = {
    workspaceRegistry: { create: async path => { assert.equal(path, root); return { id: 'workspace' }; } },
    sessionController: { create: async args => { calls.push(args.sessionId); agents.set(args.sessionId, { model: { select: value => assert.deepEqual(value, selection) } }); return { sessionId: args.sessionId }; }, rename: async () => {} },
    agents: { get: id => agents.get(id) }, tools: { guard: fn => { guard = fn; } },
  };
  const options = { root, selected: async () => item, configured: () => { throw new Error('No analysis before sending'); }, hostModel: { capture: async () => ({ selection }) }, locks: new Set() };
  const analysis = createAnalysisConversation(ctx, options);
  const draft = await analysis.draft({}); const second = await analysis.draft({});
  assert.notEqual(draft.sessionId, second.sessionId); assert.match(draft.prompt, /skillnet_analyze_submit/);
  assert.match(draft.prompt, new RegExp(root.replaceAll('\\', '\\\\')));
  assert.equal((await analysis.status({ sessionId: draft.sessionId })).status, 'draft');
  assert.equal((await analysis.status({ sourcePath: root })).sessionId, second.sessionId);
  assert.match(await guard({ agent: { id: draft.sessionId }, name: 'shell' }), /只使用分步分析/);
  assert.equal(guard({ agent: { id: draft.sessionId }, name: 'skillnet_analyze' }), undefined);
  assert.equal(await guard({ agent: { id: 'ordinary-user-session' }, name: 'shell' }), undefined);
  await assert.rejects(analysis.step({}, { agent: { id: 'ordinary-user-session' } }), /标识无效/);
  // A fresh plugin instance recovers the binding and its tool restriction.
  const reopened = createAnalysisConversation(ctx, options);
  assert.equal((await reopened.status({ sessionId: draft.sessionId })).status, 'draft');
  assert.match(await guard({ agent: { id: draft.sessionId }, name: 'shell' }), /只使用分步分析/);
});
