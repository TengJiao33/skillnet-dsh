import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  return { root, skills, request, step, backend };
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
  assert.equal(first.task.schema.$defs, undefined);
  assert.equal(first.task.schema.properties.capability.$ref, undefined);
  assert.ok(first.task.schema.properties.capability.properties.evidence.items.properties.line.maximum >= 6);
  assert.match(first.task.guide, /skillnet_analyze_submit/);
  assert.match(first.task.guide, /简体中文/);
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
  assert.match(relation.task.guide, /简体中文/);
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
  assert.match(invalid.error.message, /字符串/);
  assert.deepEqual(invalid.task, value.task);
  invalid = await call({ stepId: value.task.stepId, result: { ...answer(value.task), capability: { text: 'invented', evidence: [{ line: 99999 }] } } });
  assert.equal(invalid.status, 'needs_correction'); assert.equal(invalid.progress.profiles, 0);
  assert.match(invalid.error.message, /csv-first/);
  // A stringified JSON object is parsed safely without consuming a correction round.
  value = await call({ stepId: value.task.stepId, result: JSON.stringify(answer(value.task)) });
  value = await call({ stepId: value.task.stepId, result: answer(value.task) });
  const badRelation = answer(value.task); badRelation.decision.relations[0].source = 'not-a-candidate';
  invalid = await call({ stepId: value.task.stepId, result: badRelation });
  assert.equal(invalid.status, 'needs_correction'); assert.equal(invalid.progress.relations, 0);
  const badRelationLine = answer(value.task); badRelationLine.decision.relations[0].contexts[0].target_evidence = [{ line: 999 }];
  invalid = await call({ stepId: value.task.stepId, result: badRelationLine });
  assert.equal(invalid.status, 'needs_correction');
  assert.match(invalid.error.message, /target_evidence.*csv-second/);
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

test('preparing a graph conversation checks changes, then creates only a fresh user session and draft without starting analysis', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-graph-draft-')); t.after(() => rm(root, { recursive: true, force: true }));
  const selection = { provider: 'fixture', model: 'current', reasoningEffort: 'high' }, calls = [], agents = new Map(); let guard;
  const item = { id: 'connected-library', name: '个人库', sourcePath: root, indexPath: join(root, '.skillnet') };
  const ctx = {
    workspaceRegistry: { create: async (path, title) => {
      assert.equal(path, root);
      assert.equal(title, item.name);
      return { id: 'workspace', title };
    } },
    sessionController: { create: async args => { calls.push(args.sessionId); agents.set(args.sessionId, { model: { select: value => assert.deepEqual(value, selection) } }); return { sessionId: args.sessionId }; }, rename: async () => {} },
    agents: { get: id => agents.get(id) }, tools: { guard: fn => { guard = fn; } },
  };
  const plan = { added: 4, modified: 0, removed: 0, reusableProfiles: 25, pendingProfiles: 4, upToDate: false, summary: '新增 4 项，复用 25 项画像，待分析 4 项' };
  const options = { root, selected: async () => item, configured: async request => { assert.equal(request.action, 'analysis-plan'); assert.deepEqual(request.modelSelection, selection); return plan; }, hostModel: { capture: async () => ({ selection }) }, locks: new Set() };
  const analysis = createAnalysisConversation(ctx, options);
  const draft = await analysis.draft({}); const second = await analysis.draft({});
  assert.notEqual(draft.sessionId, second.sessionId); assert.match(draft.prompt, /^请为技能库「个人库」建立技能关系图/);
  assert.match(draft.prompt, /先调用 skillnet_analyze 领取当前步骤/);
  assert.match(draft.prompt, /建图方式：.+\n本次范围：/);
  assert.match(draft.prompt, /修正这一步并重交/);
  assert.match(draft.prompt, /用简体中文简要说明/);
  assert.match(draft.prompt, /新增 4 项，复用 25 项画像/);
  assert.doesNotMatch(draft.prompt, /技能目录：/);
  assert.doesNotMatch(draft.prompt, /不加载或执行/);
  assert.deepEqual(draft.plan, plan);
  assert.equal((await analysis.status({ sessionId: draft.sessionId })).status, 'draft');
  assert.equal((await analysis.status({ sourcePath: root })).sessionId, second.sessionId);
  assert.match(await guard({ agent: { id: draft.sessionId }, name: 'shell' }), /只使用 skillnet_analyze/);
  assert.equal(guard({ agent: { id: draft.sessionId }, name: 'skillnet_analyze' }), undefined);
  assert.equal(await guard({ agent: { id: 'ordinary-user-session' }, name: 'shell' }), undefined);
  await assert.rejects(analysis.step({}, { agent: { id: 'ordinary-user-session' } }), /标识无效/);
  // A fresh plugin instance recovers the binding and its tool restriction.
  const reopened = createAnalysisConversation(ctx, options);
  assert.equal((await reopened.status({ sessionId: draft.sessionId })).status, 'draft');
  assert.match(await guard({ agent: { id: draft.sessionId }, name: 'shell' }), /只使用 skillnet_analyze/);
});

test('existing graph workspaces follow the library display names and keep their paths', async () => {
  const root = join(tmpdir(), 'skillnet-workspace-titles');
  const graphSession = 'skillnet-analysis-0cfd927f-d2a3-40ea-aaee-4562c2f2234e';
  const personal = { name: 'DSH 个人技能库', sourcePath: join(root, 'skills') };
  const thesis = { name: '论文', sourcePath: join(root, '论文', 'skills') };
  const external = { name: '外部技能库', sourcePath: join(root, 'external', 'skills') };
  const named = [];
  const workspace = (path, sessionIds) => ({
    path, title: 'skills', sessionIds,
    async setTitle(title) { named.push({ path: this.path, title }); this.title = title; },
  });
  const workspaces = [workspace(personal.sourcePath, [graphSession]), workspace(thesis.sourcePath, [graphSession]),
    workspace(external.sourcePath, ['other-session']), workspace(join(root, 'other', 'skills'), [graphSession])];
  const analysis = createAnalysisConversation({ workspaceRegistry: { list: () => workspaces } }, { root });
  await analysis.syncWorkspaceTitles([personal, thesis, external]);
  await analysis.syncWorkspaceTitles([personal, thesis, external]);
  assert.deepEqual(named, [personal, thesis].map(item => ({ path: item.sourcePath, title: item.name })));
  assert.deepEqual(workspaces.map(item => item.title), ['DSH 个人技能库', '论文', 'skills', 'skills']);
});

test('one native turn repairs malformed requests and validation errors in the original conversation', async t => {
  const f = await fixture(t);
  const selection = f.request.modelSelection;
  const item = { id: 'connected-library', name: '论文', sourcePath: f.skills, indexPath: f.request.indexPath };
  const agents = new Map();
  const messages = [];
  const hooks = new Map();
  let correctionContext;
  const ctx = {
    on: (name, listener) => hooks.set(name, listener),
    systemPrompt: { context: entry => { correctionContext = entry; } },
    workspaceRegistry: { create: async (_path, title) => ({ id: 'workspace', title: title }) },
    sessionController: {
      create: async ({ sessionId }) => {
        const agent = { id: sessionId, status: 'idle', events: [], model: { select() {} },
          session: { snapshotEvents: () => agent.events },
          followup(message) { messages.push(message); agent.status = 'running'; },
          cancel() { agent.status = 'idle'; } };
        agents.set(sessionId, agent);
        return { sessionId };
      },
      rename: async () => {},
    },
    agents: { get: id => agents.get(id) },
    jobs: { start() { throw new Error('Conversation analysis must not start a background job'); } },
  };
  const analysis = createAnalysisConversation(ctx, {
    root: f.root, selected: async () => item, configured: f.backend, locks: new Set(),
    hostModel: { capture: async () => ({ selection }), agentFor: async id => agents.get(id),
      invoke() { throw new Error('Conversation analysis must not create a model agent'); } },
  });
  const draft = await analysis.draft({});
  assert.equal(messages.length, 0);
  const agent = agents.get(draft.sessionId);
  const signal = new AbortController().signal;
  const event = { agent, signal, failure: { code: 'MALFORMED_RESPONSE', message: 'invalid JSON args' } };
  const requestError = hooks.get('agent/request-error');
  agent.status = 'running'; // The user sent the ordinary DSH draft.
  assert.deepEqual(await analysis.draft({}), { alreadyRunning: true, sessionId: draft.sessionId });
  const step = (args = {}) => analysis.step(args, { agent });
  const first = await step();
  assert.ok(first.guide);
  const second = await step({ stepId: first.task.stepId, result: answer(first.task) });
  assert.equal(second.guide, undefined);
  assert.equal(second.task.payload.skill_id, 'csv-second');
  assert.equal((await analysis.status({ sessionId: draft.sessionId })).cancellable, true);
  // The provider rejects bad JSON before tool dispatch. Repair uses the native
  // request retry and a runtime context, without adding a user message.
  assert.deepEqual(await requestError(event, () => assert.fail('Must handle the first malformed response')), { kind: 'retry' });
  assert.match(correctionContext.text({ signal }), /不是合法 JSON/);
  const saved = await analysis.status({ sessionId: draft.sessionId });
  assert.equal(saved.status, 'running');
  assert.equal(saved.progress.profiles, 1);
  assert.equal(messages.length, 0);
  await assert.rejects(readFile(join(item.indexPath, 'CURRENT')), { code: 'ENOENT' });

  await assert.rejects(requestError(event, () => assert.fail('Must not duplicate retry')), /^Error: 本次图谱暂未更新。$/);
  hooks.get('agent/pre-step')(event, () => {});
  assert.equal(correctionContext.text({ signal }), '');
  const ordinary = { ...event, agent: { id: 'ordinary-user-session' } };
  assert.equal(await requestError(ordinary, () => 'delegated'), 'delegated');

  const resumed = await step();
  assert.deepEqual(resumed.task, second.task);
  const invalid = answer(resumed.task);
  invalid.capability.evidence[0].line = 999;
  const corrected = await step({ stepId: resumed.task.stepId, result: invalid });
  assert.equal(corrected.status, 'needs_correction');
  assert.ok(corrected.guide);
  assert.deepEqual(corrected.task, resumed.task);
  const relation = await step({ stepId: resumed.task.stepId, result: answer(resumed.task) });
  assert.equal(relation.guide, undefined);
  assert.match(relation.task.guide, /source_evidence/);
  await step({ stepId: relation.task.stepId, result: answer(relation.task) });
  const ready = await analysis.status({ sessionId: draft.sessionId });
  assert.equal(ready.status, 'completed');
  assert.equal(ready.result.relation_counts.similar_to, 1);
  assert.ok((await readFile(join(item.indexPath, 'CURRENT'), 'utf8')).trim());
  const final = await analysis.confirm({ agent });
  assert.deepEqual(final, { kind: 'success', text: '图谱已更新。分析了 2 个技能，得到 1 条关系。' });
  assert.equal(messages.length, 0);
});

test('reclaiming the same step does not reset the validation retry limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-correction-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = { id: 'library', name: '论文', sourcePath: root, indexPath: join(root, '.skillnet') };
  const agent = { status: 'idle', model: { select() {} } };
  const ctx = { agents: { get: () => agent }, workspaceRegistry: { create: async (_path, title) => ({ id: 'workspace', title }) },
    sessionController: { create({ sessionId }) { agent.id = sessionId; return { sessionId }; }, rename() {} } };
  const pending = { status: 'awaiting_result', task: { stepId: 'profile:csv-first' }, progress: { profiles: 0, skills: 1 } };
  const invalid = { ...pending, status: 'needs_correction',
    error: { message: 'invalid evidence' } };
  const analysis = createAnalysisConversation(ctx, {
    root, selected: async () => item, locks: new Set(),
    hostModel: { capture: async () => ({ selection: { provider: 'fixture', model: 'fixed' } }) },
    configured: async request => {
      if (request.action === 'analysis-plan') return { summary: '新增 1 项' };
      return request.stepId ? invalid : pending;
    },
  });
  await analysis.draft({});
  let concludes = 0;
  const step = () => analysis.step({ stepId: invalid.task.stepId, result: {} }, { agent, concludeTurn() { concludes++; } });
  assert.equal((await step()).status, 'needs_correction');
  assert.equal(concludes, 0);
  assert.equal((await analysis.step({}, { agent })).task.stepId, pending.task.stepId);
  assert.equal((await step()).status, 'needs_correction');
  assert.equal(concludes, 0);
  assert.equal((await analysis.step({}, { agent })).task.stepId, pending.task.stepId);
  const exhausted = await step();
  assert.equal(concludes, 1);
  assert.equal(exhausted.message, '本次图谱暂未更新。');
  assert.equal(exhausted.error, undefined);
  assert.equal((await analysis.status({ sessionId: agent.id })).status, 'failed');
});

test('an up-to-date graph does not create a conversation, workspace or draft record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-up-to-date-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const analysis = createAnalysisConversation({
    workspaceRegistry: { create() { throw new Error('No new workspace'); } },
    sessionController: { create() { throw new Error('No new conversation'); } },
  }, { root, selected: async () => ({ sourcePath: root, indexPath: join(root, '.skillnet') }),
    configured: async request => { assert.equal(request.action, 'analysis-plan'); return { upToDate: true }; },
    hostModel: { capture: async () => ({ selection: { provider: 'fixture', model: 'same' } }) }, locks: new Set() });
  const reply = await analysis.draft({});
  assert.equal(reply.upToDate, true);
  assert.equal(reply.message, '图谱已是最新。');
  assert.equal(reply.sessionId, undefined);
  await assert.rejects(readFile(join(root, 'analysis-conversations')), { code: 'ENOENT' });
});

test('update planning reads current caches without publishing, detects changes and refuses another model', async t => {
  const f = await fixture(t);
  const check = changes => f.step({ action: 'analysis-plan', ...changes });
  const first = await check();
  assert.equal(first.added, 2); assert.equal(first.reusableProfiles, 0); assert.equal(first.upToDate, false);
  await finish(f, await f.step());
  const pointerPath = join(f.request.indexPath, 'CURRENT');
  const before = await readFile(pointerPath, 'utf8');
  const current = await check();
  assert.equal(current.upToDate, true);
  assert.equal(current.reusableProfiles, 2);
  assert.equal(await readFile(pointerPath, 'utf8'), before);
  const legacyIndex = join(f.root, 'legacy-index');
  await cp(f.request.indexPath, legacyIndex, { recursive: true });
  const legacyConfig = join(legacyIndex, before.trim(), 'analysis-config.json');
  const withoutLocale = JSON.parse(await readFile(legacyConfig, 'utf8'));
  assert.equal(withoutLocale.output_locale, 'zh-CN');
  delete withoutLocale.output_locale;
  await writeFile(legacyConfig, JSON.stringify(withoutLocale));
  const legacyCache = spawnSync(pythonExecutable(), ['-c', `
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    for namespace, key in connection.execute("SELECT namespace, key FROM results WHERE namespace IN ('profile', 'relation')").fetchall():
        parts = json.loads(key)
        parts.remove('zh-CN')
        connection.execute('UPDATE results SET key=? WHERE namespace=? AND key=?', (json.dumps(parts, sort_keys=True), namespace, key))
`, join(legacyIndex, 'cache.sqlite')], { encoding: 'utf8' });
  assert.equal(legacyCache.status, 0, legacyCache.stderr);
  const legacy = await check({ indexPath: legacyIndex });
  assert.equal(legacy.upToDate, false);
  assert.equal(legacy.reusableProfiles, 0);
  assert.equal(legacy.pendingProfiles, 2);
  assert.equal(await readFile(join(legacyIndex, 'CURRENT'), 'utf8'), before);
  const other = await check({ modelSelection: { provider: 'other', model: 'current' } });
  assert.equal(other.upToDate, false); assert.equal(other.reusableProfiles, 0);
  // Legacy snapshots are checked against the exact cached candidate judgments.
  await rm(join(f.request.indexPath, before.trim(), 'analysis-config.json'));
  assert.equal((await check()).upToDate, true);
  const removedCache = spawnSync(pythonExecutable(), ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"DELETE FROM results WHERE namespace='relation'\"); c.commit(); c.close()", join(f.request.indexPath, 'cache.sqlite')], { encoding: 'utf8' });
  assert.equal(removedCache.status, 0, removedCache.stderr);
  assert.equal((await check()).upToDate, false);
  const directory = join(f.skills, 'csv-third'); await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), '---\nname: csv-third\ndescription: Process CSV rows.\n---\n# Third\nProcess CSV rows.\n');
  const added = await check();
  assert.equal(added.upToDate, false); assert.equal(added.added, 1);
  assert.equal(added.unchanged, 2); assert.equal(added.reusableProfiles, 2); assert.equal(added.pendingProfiles, 1);
  await writeFile(join(f.skills, 'csv-first', 'SKILL.md'), '---\nname: csv-first\ndescription: Changed CSV processing.\n---\n# First\nProcess different CSV rows.\n');
  await rm(join(f.skills, 'csv-second'), { recursive: true });
  const changed = await check();
  assert.equal(changed.modified, 1); assert.equal(changed.removed, 1); assert.equal(changed.added, 1);
  assert.equal(await readFile(pointerPath, 'utf8'), before);
});
