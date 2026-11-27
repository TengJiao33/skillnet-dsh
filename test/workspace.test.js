import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable } from '../src/backend.js';
import { createWorkspace } from '../src/workspace.js';
import { createLibrary } from '../src/library.js';
import { createHash } from 'node:crypto';
import { createTaskStore } from '../src/task-store.js';

test('saved evaluation returns the latest success for the selected skill, across remounts and newer failures', async t => {
  const f = await fixture(t);
  const store = createTaskStore(join(f.home, 'skillnet'));
  const report = label => ({ safety: { level: 'Good', reason: label } });
  for (const record of [
    { id: 'skillnet-evaluate-a1', skillId: 'first', status: 'completed', startedAt: '2026-11-16T01:00:00Z', result: report('first-old') },
    { id: 'skillnet-evaluate-a2', skillId: 'first', status: 'completed', startedAt: '2026-11-16T02:00:00Z', result: report('first-latest') },
    { id: 'skillnet-evaluate-a3', skillId: 'second', status: 'completed', startedAt: '2026-11-16T03:00:00Z', result: report('second-only') },
    { id: 'skillnet-evaluate-a4', skillId: 'first', status: 'failed', startedAt: '2026-11-16T04:00:00Z', error: 'new attempt failed' },
  ]) await store.write({ ...record, action: 'evaluate', sourcePath: f.path, libraryId: f.item.id });
  for (const workspace of [f.workspace, createWorkspace(f.ctx, async () => ({}), { home: f.home })]) {
    const first = await workspace.latestEvaluation({ sourcePath: f.path, skillId: 'first' });
    assert.equal(first.id, 'skillnet-evaluate-a2'); assert.equal(first.result.safety.reason, 'first-latest');
    assert.equal(first.versionStatus, 'unversioned');
    assert.equal((await workspace.latestEvaluation({ sourcePath: f.path, skillId: 'second' })).result.safety.reason, 'second-only');
    assert.equal(await workspace.latestEvaluation({ sourcePath: f.path, skillId: 'never-evaluated' }), null);
  }
});

async function fixture(t, hostModel, skills = []) {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-workspace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'skills'); await mkdir(path);
  const stored = new Map(); const jobs = new Map(); const requests = [];
  const ctx = {
    credentials: { resolve: key => stored.has(key) ? { value: stored.get(key) } : undefined, set: (k, v) => stored.set(k, v), unset: key => stored.delete(key) },
    jobs: {
      start(spec) {
        const id = `${spec.kind}-${String(jobs.size).padStart(16, '0')}`;
        const job = { id, owner: spec.owner, status: 'running', progress: '' };
        jobs.set(id, job);
        const hooks = spec.run({ id, updateProgress: line => { job.progress = line }, append() {} });
        job.hooks = hooks; hooks.done.then(outcome => { Object.assign(job, outcome) });
        return id;
      },
      get: (id, owner) => {
        const job = jobs.get(id);
        if (!job) throw new Error(`unknown job ${id}`);
        if (job.owner && job.owner !== owner) throw new Error(`job ${id} belongs to another session`);
        return job;
      },
      kill(id, owner) { const job = this.get(id, owner); job.hooks.cancel(); },
    },
  };
  let release;
  let wait = false;
  let stale = false;
  let graph = {};
  let pendingProfiles = [];
  let native;
  let evaluate;
  const run = async (req, signal) => {
    requests.push(req);
    if (req.action === 'settings') return { fields: Object.fromEntries(Object.entries(req._settings).map(([k, v]) => [k, { value: (k.endsWith('key') || k === 'github_token') ? Boolean(v) : v }])), checks: {} };
    if (req.action === 'local-library') return { source: { skills }, graph: req.indexPath?.endsWith('invalid') ? null : graph, analysisError: req.indexPath?.endsWith('invalid') ? 'invalid analysis' : null, changedSkills: Number(stale), addedSkills: 0, removedSkills: 0, pendingProfiles };
    if (wait) await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) });
    if (req.action === 'evaluate' && evaluate) return evaluate(req, signal);
    return { skill_count: 2 };
  };
  const resolver = createLibrary(run, { get: (name, options) => native?.get(name, options) }, { dshHome: home });
  const workspace = createWorkspace(ctx, run, { ...resolver, prepareLocal: async (path, _signal, origin) => ({ path, origin, previewId: 'fixture-preview' }) }, hostModel);
  await workspace.settings({ values: { api_key: 'fixture-private-key', base_url: 'http://127.0.0.1:1/v1', model: 'fixture', embedding_api_key: 'fixture-embedding-key', embedding_base_url: 'http://127.0.0.1:1/v1', embedding_model: 'fixture-embedding', explorer_api_key: 'fixture-explorer-key', explorer_base_url: 'http://127.0.0.1:1/v1', explorer_model: 'fixture-explorer' } });
  await workspace.connect({ sourcePath: path });
  const item = (await workspace.listLibraries())[0];
  return { home, path, workspace, ctx, requests, item, block: () => { wait = true }, release: () => release(), stale: () => { stale = true },
    graph: value => { graph = value }, profiles: value => { pendingProfiles = value }, useNative: value => { native = value },
    evaluate: value => { evaluate = value } };
}
const until = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Task did not settle.'); };

async function evaluationFixture(t, host, names) {
  const skills = [];
  const f = await fixture(t, host, skills);
  for (const name of names) {
    const directory = join(f.path, name);
    await mkdir(directory);
    const source = `---\nname: ${name}\ndescription: test evaluation\n---\nSee support.js.`;
    const path = join(directory, 'SKILL.md');
    await writeFile(path, source);
    await writeFile(join(directory, 'support.js'), '// original supporting file');
    skills.push({ id: name, name, path, source });
  }
  return f;
}

test('single evaluations bind supporting files and prefer a completed result for the current package version', async t => {
  const f = await evaluationFixture(t, undefined, ['fixture']);
  const args = { libraryId: f.item.id, skillId: 'fixture' };
  const run = async () => {
    const task = await f.workspace.start({ ...args, action: 'evaluate' });
    await f.ctx.jobs.get(task.id).hooks.done;
    return f.workspace.getTask(task.id);
  };
  const original = await run();
  assert.equal(original.status, 'completed'); assert.match(original.sourceVersion, /^[\da-f]{64}$/);
  assert.equal((await f.workspace.latestEvaluation(args)).versionStatus, 'current');
  const support = join(f.path, 'fixture', 'support.js');
  await writeFile(support, '// second supporting file');
  assert.equal((await f.workspace.latestEvaluation(args)).versionStatus, 'historical');
  const newer = await run();
  assert.notEqual(newer.sourceVersion, original.sourceVersion);
  await writeFile(support, '// original supporting file');
  const restored = await f.workspace.latestEvaluation(args);
  assert.equal(restored.versionStatus, 'current'); assert.equal(restored.id, original.id);
  f.evaluate(async () => { await writeFile(support, '// modified during inference'); return { safety: { level: 'Good' } }; });
  const changed = await run();
  assert.equal(changed.status, 'failed'); assert.match(changed.error, /评估期间技能包已改变/);
  assert.equal(changed.result, undefined);
  assert.equal((await f.workspace.latestEvaluation(args)).versionStatus, 'historical');
});

test('batch evaluations retain per-skill history, reuse the chosen model on retry, and skip assessed package versions', async t => {
  let captures = 0;
  const host = { capture: async (_execution, id) => {
    assert.equal(id, 'chosen-session'); captures++;
    return { selection: { provider: 'fixture-host', model: 'chosen-model', reasoningEffort: 'low' }, sessionId: id };
  } };
  const f = await evaluationFixture(t, host, ['first', 'second', 'third']);
  const args = { action: 'evaluate-batch', libraryId: f.item.id };
  await assert.rejects(f.workspace.start(args), /明确选择/);
  const evaluated = [];
  let fail = true;
  f.evaluate(async request => {
    assert.deepEqual(request._host_model, { provider: 'fixture-host', model: 'chosen-model', reasoningEffort: 'low' });
    const skill = basename(request.path); evaluated.push(skill);
    if (skill === 'second' && fail) throw new Error('Second skill could not be evaluated.');
    return { safety: { level: 'Good', reason: skill } };
  });
  const settled = async options => {
    const job = await f.workspace.start({ ...args, ...options });
    await f.ctx.jobs.get(job.id).hooks.done;
    return f.workspace.getTask(job.id);
  };
  const first = await settled({ sessionId: 'chosen-session', batchMode: 'all' });
  assert.equal(first.status, 'completed');
  assert.deepEqual(evaluated, ['first', 'second', 'third']);
  assert.equal(first.result.completed, 2); assert.equal(first.result.failed, 1);
  assert.deepEqual(first.result.items.map(item => item.status), ['completed', 'failed', 'completed']);
  const successful = await f.workspace.latestEvaluation({ libraryId: f.item.id, skillId: 'first' });
  assert.equal(successful.id, first.result.items[0].taskId);
  assert.equal(successful.versionStatus, 'current');

  fail = false;
  const retried = await settled({ retryTaskId: first.id });
  assert.equal(captures, 1);
  assert.deepEqual(retried.model, first.model); assert.equal(retried.sessionId, 'chosen-session');
  assert.deepEqual(evaluated, ['first', 'second', 'third', 'second']);
  assert.deepEqual(retried.result.items.map(item => [item.skillId, item.status]), [['second', 'completed']]);
  assert.equal((await f.workspace.latestEvaluation({ libraryId: f.item.id, skillId: 'first' })).id, successful.id);

  await writeFile(join(f.path, 'first', 'support.js'), '// a new package version');
  const missing = await settled({ sessionId: 'chosen-session' });
  assert.deepEqual(missing.result.items.map(item => item.status), ['completed', 'skipped', 'skipped']);
  assert.equal(missing.result.skipped, 2);
  assert.deepEqual(evaluated, ['first', 'second', 'third', 'second', 'first']);
});

test('batch cancellation preserves completed and failed evaluations and does not start queued skills', async t => {
  const host = { capture: async () => ({ selection: { provider: 'fixture', model: 'evaluation-model' } }) };
  const f = await evaluationFixture(t, host, ['completed', 'failed', 'running', 'queued']);
  const entered = Promise.withResolvers();
  const evaluated = [];
  let failedOnce = false;
  f.evaluate(async (request, signal) => {
    const skill = basename(request.path); evaluated.push(skill);
    if (skill === 'failed' && !failedOnce) { failedOnce = true; throw new Error('Transient evaluation error.'); }
    if (skill === 'running') {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { safety: { level: 'Good' } };
  });
  const start = params => f.workspace.start({ action: 'evaluate-batch', libraryId: f.item.id, modelSource: 'host', ...params });
  const job = await start();
  await entered.promise;
  await assert.rejects(start(), /已有批量评估/);
  await f.workspace.cancel({ id: job.id });
  await f.ctx.jobs.get(job.id).hooks.done;
  const result = await f.workspace.getTask(job.id);
  assert.equal(result.status, 'killed');
  assert.deepEqual(result.result.items.map(item => item.status), ['completed', 'failed', 'unattempted', 'unattempted']);
  assert.deepEqual(evaluated, ['completed', 'failed', 'running']);
  assert.equal((await f.workspace.latestEvaluation({ libraryId: f.item.id, skillId: 'completed' })).versionStatus, 'current');
  const retry = await start({ retryTaskId: job.id });
  await f.ctx.jobs.get(retry.id).hooks.done;
  assert.deepEqual(evaluated, ['completed', 'failed', 'running', 'failed']);
});

test('independent model batch retry refuses changed SDK configuration before evaluating', async t => {
  const f = await evaluationFixture(t, undefined, ['fixture']);
  f.evaluate(async () => { throw new Error('Transient SDK error'); });
  const args = { action: 'evaluate-batch', libraryId: f.item.id, modelSource: 'sdk' };
  const job = await f.workspace.start(args);
  await f.ctx.jobs.get(job.id).hooks.done;
  assert.equal((await f.workspace.getTask(job.id)).result.failed, 1);
  await f.workspace.settings({ values: { model: 'different-sdk-model' } });
  await assert.rejects(f.workspace.start({ ...args, retryTaskId: job.id }), /模型配置已改变/);
  assert.equal(f.requests.filter(request => request.action === 'evaluate').length, 1);
});

test('skill status reports selected package identity and independent invocation permissions without preview', async t => {
  const agent = { id: 'target-session' };
  const f = await evaluationFixture(t, { agentFor: async id => { assert.equal(id, agent.id); return agent; } }, ['fixture']);
  f.ctx.workingDirectory = { ensure: async scope => { assert.equal(scope, agent); return f.path; } };
  const expected = join(f.path, 'fixture', 'SKILL.md');
  let entry = { path: expected, invocation: { modelInvocable: false, userInvocable: true } };
  f.useNative({ get: async (name, { scope, cwd }) => {
    assert.equal(name, 'fixture'); assert.equal(scope, agent); assert.equal(cwd, f.path);
    return entry;
  } });
  const args = { libraryId: f.item.id, skillId: 'fixture', sessionId: agent.id };
  assert.deepEqual(await f.workspace.skillStatus(args), { status: 'available', sourcePath: f.path, expectedPath: expected,
    actualPath: expected, effectivePath: expected, modelInvocable: false, userInvocable: true });
  entry = { path: join(f.home, 'shadow', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true } };
  const mismatch = await f.workspace.skillStatus(args);
  assert.equal(mismatch.code, 'native_path_mismatch'); assert.equal(mismatch.actualPath, entry.path);
  assert.equal(mismatch.modelInvocable, false); assert.equal(mismatch.userInvocable, false);
  entry = undefined;
  assert.equal((await f.workspace.skillStatus(args)).code, 'native_missing');
  assert.equal(f.requests.some(request => request.action === 'check'), false);
  await assert.rejects(stat(join(f.home, 'skillnet', 'previews')), { code: 'ENOENT' });
});

test('analysis progress names the active skill and retains its failure context', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const host = {
    capture: async () => ({ selection: { provider: 'fixture', model: 'current', reasoningEffort: 'high' } }),
    async invoke(_model, _payload, _signal, onSession) {
      await onSession('fixture-analysis-session');
      await waiting;
      throw new Error('提取画像：citation-management：DSH 模型调用超时（600 秒），已停止本次调用。');
    },
  };
  const f = await fixture(t, host);
  const workspace = createWorkspace(f.ctx, async (request, signal, invoke) => {
    if (request.action === 'analyze') return invoke({ method: 'chat', label: '提取画像：citation-management' }, signal);
    return { source: { skills: [] }, graph: null, changedSkills: 0, addedSkills: 0, removedSkills: 0 };
  }, { home: f.home }, host);
  const task = await workspace.start({ action: 'analyze', libraryId: f.item.id });
  await until(() => f.ctx.jobs.get(task.id).progress === '正在提取画像：citation-management');
  release();
  await f.ctx.jobs.get(task.id).hooks.done;
  const saved = await workspace.getTask(task.id);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /citation-management.*600 秒/);
});

test('first open creates the native user skill directory under the resolved DSH home without calling a model', async t => {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-default-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = createWorkspace({}, async () => { throw new Error('Unexpected SDK or model request'); }, { home });
  const sourcePath = join(home, 'skills');
  await assert.rejects(stat(sourcePath), { code: 'ENOENT' });
  assert.deepEqual(await workspace.config(), { sourcePath });
  assert.equal((await stat(sourcePath)).isDirectory(), true);
  assert.deepEqual(await workspace.config(), { sourcePath });
});

test('a new graph job uses the resolved effort for profiles, relations and cache identity', async t => {
  const original = { provider: 'host', model: 'current', reasoningEffort: 'high' };
  const invoked = [];
  let resolved = 0;
  const host = {
    async capture() { return { selection: original } },
    async forRelationReview(model) {
      resolved++;
      return { ...model, selection: { ...model.selection, reasoningEffort: 'off' } };
    },
    async invoke(model, payload) { invoked.push([payload.phase, model.selection.reasoningEffort]) },
  };
  const f = await fixture(t, host);
  const workspace = createWorkspace(f.ctx, async (request, signal, invoke) => {
    if (request.action === 'settings') return { fields: {}, checks: {} };
    if (request.action === 'analysis-plan') {
      assert.deepEqual(request.modelSelection, { ...original, reasoningEffort: 'off' });
      return { upToDate: false };
    }
    assert.equal(request.action, 'analyze');
    assert.deepEqual(request._host_model, { ...original, reasoningEffort: 'off' });
    await invoke({ phase: 'profile' }, signal);
    await invoke({ phase: 'relation' }, signal);
    return { cache_hits: { profiles: 1, relations: 1 } };
  }, { home: f.home }, host);
  const started = await workspace.start({ action: 'analyze', libraryId: f.item.id });
  await f.ctx.jobs.get(started.id).hooks.done;
  const saved = await workspace.getTask(started.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.relationReasoningEffort, 'off');
  assert.deepEqual(saved.model, original);
  assert.deepEqual(saved.result.cache_hits, { profiles: 1, relations: 1 });
  assert.deepEqual(invoked, [['profile', 'off'], ['relation', 'off']]);
  assert.equal(resolved, 1);
});

test('a targeted retry uses the published task model and skips candidate planning', async t => {
  const host = {
    capture: () => assert.fail('a retry should reuse the original model'),
    forRelationReview: () => assert.fail('a retry should reuse the original reasoning effort'),
  };
  const f = await fixture(t, host);
  const record = { id: 'skillnet-analyze-a3', action: 'analyze', status: 'completed', sourcePath: f.path,
    libraryId: f.item.id, startedAt: '2026-11-24T01:00:00Z', retrievalMode: 'vector',
    model: { provider: 'original', model: 'original-model', reasoningEffort: 'high' }, relationReasoningEffort: 'off',
    result: { pending_relations: 1 } };
  const store = createTaskStore(join(f.home, 'skillnet'));
  await store.write(record);
  const index = join(f.path, '.skillnet');
  await mkdir(index); await writeFile(join(index, 'CURRENT'), 'snapshot-before-update\n');
  const job = await f.workspace.start({ action: 'analyze', libraryId: f.item.id, retryTaskId: record.id, modelSource: 'sdk' });
  await f.ctx.jobs.get(job.id).hooks.done;
  const req = f.requests.find(r => r.action === 'analyze');
  assert.equal(req.retrySnapshot, 'snapshot-before-update');
  assert.equal(req.retrievalMode, 'vector');
  assert.deepEqual(req._host_model, { ...record.model, reasoningEffort: 'off' });
  assert.ok(!f.requests.some(r => r.action === 'analysis-plan'));
  await assert.rejects(f.workspace.start({ action: 'analyze', libraryId: f.item.id, retryTaskId: record.id }), /图谱已有更新/);
});

test('local library browsing does not resolve model credentials or load model settings', async t => {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-reader-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sourcePath = join(home, 'skills'); await mkdir(sourcePath);
  const workspace = createWorkspace({ credentials: { resolve() { throw new Error('Unexpected credential lookup'); } } },
    async request => {
      assert.equal(request.action, 'local-library');
      assert.equal(request._settings, undefined);
      return { source: { skills: [] }, graph: null, analysisError: null };
    }, { home });
  const result = await workspace.connect({ sourcePath });
  assert.equal(result.connection.sourcePath, sourcePath);
});

test('public catalog browsing preserves its endpoint without resolving or forwarding model credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-discover-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'skillnet'));
  await writeFile(join(home, 'skillnet/settings.json'), JSON.stringify({ skillnet_api_url: 'http://127.0.0.1:1234', api_key: 'fixture-private', model: 'unused' }));
  const workspace = createWorkspace({ credentials: { resolve() { throw new Error('Unexpected credential lookup'); } } }, async request => {
    assert.equal(request.action, 'discover');
    assert.deepEqual(request._settings, { skillnet_api_url: 'http://127.0.0.1:1234' });
    return { skills: [] };
  }, { home });
  assert.deepEqual(await workspace.configured({ action: 'discover' }), { skills: [] });
});

test('catalog source checks resolve only the GitHub credential', async t => {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-source-check-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = createWorkspace({ credentials: { resolve(key) {
    assert.equal(key, 'DSH_SKILLNET_GITHUB_TOKEN');
    return { value: 'fixture-github-token' };
  } } }, async request => {
    assert.equal(request.action, 'source-status');
    assert.deepEqual(request._settings, { github_token: 'fixture-github-token' });
    return [];
  }, { home });
  assert.deepEqual(await workspace.configured({ action: 'source-status', urls: [] }), []);
});

test('a real unbuilt library reopens with its saved default index path without creating or requiring an analysis folder', async t => {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-unbuilt-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sourcePath = join(home, 'skills');
  await mkdir(join(sourcePath, 'fixture-skill'), { recursive: true });
  await writeFile(join(sourcePath, 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Read fixture data.\n---\nRead the supplied data.\n');
  const requests = [];
  const run = async request => {
    assert.equal(request.action, 'local-library');
    requests.push(request);
    const result = spawnSync(pythonExecutable(), [fileURLToPath(new URL('../python/worker.py', import.meta.url))], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (result.error) throw result.error;
    const value = JSON.parse(result.stdout);
    if (!value.ok) throw new Error(value.error.message);
    return value.data;
  };
  const ctx = { credentials: { resolve: () => undefined } };
  let workspace = createWorkspace(ctx, run, { home });
  const first = await workspace.connect(await workspace.config());
  assert.equal(first.analysisStatus, 'missing');
  const reload = await workspace.connect(first.connection);
  assert.equal(reload.source.skills.length, 1);
  assert.equal(reload.graph, null);
  assert.equal(reload.analysisError, null);
  workspace = createWorkspace(ctx, run, { home });
  const reopened = await workspace.connect(await workspace.config());
  assert.equal(reopened.connection.id, first.connection.id);
  assert.equal(reopened.analysisStatus, 'missing');
  assert.ok(requests.every(request => request.indexPath === undefined));
  await assert.rejects(stat(join(sourcePath, '.skillnet')), { code: 'ENOENT' });
  await assert.rejects(workspace.connect({ sourcePath, indexPath: join(home, 'missing-custom-index') }), { code: 'ENOENT' });
  assert.equal((await workspace.listLibraries())[0].indexPath, join(sourcePath, '.skillnet'));
});

test('native personal libraries are named clearly and reopening preserves an explicitly chosen project library', async t => {
  const f = await fixture(t);
  assert.equal(f.item.name, 'DSH 个人技能库');
  const projectSkills = join(f.home, 'project-skills');
  await mkdir(projectSkills);
  await f.workspace.connect({ sourcePath: projectSkills });
  assert.deepEqual(await f.workspace.config(), { sourcePath: projectSkills });
  assert.equal((await f.workspace.listLibraries()).length, 2);
  assert.deepEqual(await f.workspace.createDefault(), { sourcePath: f.path });
  assert.deepEqual(await f.workspace.config(), { sourcePath: projectSkills });
});

test('settings use credential references and never write keys into plugin metadata', async t => {
  const f = await fixture(t);
  const value = await f.workspace.settings({ values: { github_token: 'fixture-github-secret', github_mirror: 'https://mirror.example', skillnet_api_url: 'https://catalog.example' } });
  assert.equal(value.fields.api_key.value, true);
  assert.equal(value.fields.github_mirror.value, 'https://mirror.example');
  assert.equal(value.fields.skillnet_api_url.value, 'https://catalog.example');
  assert.equal((await f.workspace.settings({ values: { github_token: '' } })).fields.github_token.value, true);
  assert.equal((await f.workspace.settings({ clearSecrets: ['github_token'] })).fields.github_token, undefined);
  const json = await readFile(join(f.home, 'skillnet/settings.json'), 'utf8');
  assert.doesNotMatch(json, /fixture-github-secret/);
  assert.doesNotMatch(json, /fixture-private-key|fixture-embedding-key|fixture-explorer-key/);
  await assert.rejects(f.workspace.settings({ values: { base_url: 'https://example.com/?key=secret' } }), /HTTP/);
});

test('analysis jobs persist results, enforce one writer, and respect cancellation', async t => {
  const f = await fixture(t); f.block();
  const task = await f.workspace.start({ action: 'analyze', libraryId: f.item.id });
  await until(() => f.requests.some(r => r.action === 'analyze'));
  await assert.rejects(f.workspace.start({ action: 'analyze', libraryId: f.item.id }), /正在建图/);
  await f.workspace.cancel({ id: task.id });
  await f.ctx.jobs.get(task.id).hooks.done;
  assert.equal((await f.workspace.getTask(task.id)).status, 'killed');
  const next = await f.workspace.start({ action: 'analyze', libraryId: f.item.id });
  await until(() => f.requests.filter(r => r.action === 'analyze').length === 2);
  f.release(); await f.ctx.jobs.get(next.id).hooks.done;
  assert.equal((await f.workspace.getTask(next.id)).result.skill_count, 2);
  f.ctx.jobs.get(next.id).status = 'completed';
  assert.equal((await f.workspace.tasks()).items.length, 2);
});

test('pruned historical jobs do not break active-task polling or saved results after restart', async t => {
  const f = await fixture(t);
  const completed = await f.workspace.start({ action: 'create', content: 'Create a fixture skill.' });
  const nativeGet = f.ctx.jobs.get;
  await nativeGet(completed.id).hooks.done;
  const failedId = 'skillnet-analyze-ffff01', orphanId = 'skillnet-analyze-ffff02';
  const folder = join(f.home, 'skillnet/tasks');
  await writeFile(join(folder, failedId + '.json'), JSON.stringify({ id: failedId, action: 'analyze', status: 'failed', startedAt: '2026-11-12T00:00:00Z', finishedAt: '2026-11-12T00:00:01Z', error: 'Original model failure.' }));
  await writeFile(join(folder, orphanId + '.json'), JSON.stringify({ id: orphanId, action: 'analyze', status: 'running', startedAt: '2026-11-13T00:00:00Z' }));
  f.block();
  const active = await f.workspace.start({ action: 'analyze', libraryId: f.item.id });
  await until(() => f.requests.some(request => request.action === 'analyze'));
  const lookups = [];
  f.ctx.jobs.get = (id, owner) => {
    lookups.push(id);
    if (id === completed.id) throw new Error(`unknown job ${id}`);
    return nativeGet(id, owner);
  };
  try {
    const page = await f.workspace.tasks();
    assert.equal(page.items.find(task => task.id === active.id).status, 'running');
    assert.match(page.items.find(task => task.id === active.id).progress, /建图/);
    assert.equal(page.items.find(task => task.id === failedId).error, 'Original model failure.');
    assert.equal(page.items.find(task => task.id === orphanId).status, 'failed');
    assert.match(page.items.find(task => task.id === orphanId).error, /已中断/);
    assert.equal((await f.workspace.getTask(completed.id)).result.skill_count, 2);
    assert.ok(!lookups.includes(completed.id) && !lookups.includes(failedId));
    const saved = JSON.parse(await readFile(join(folder, orphanId + '.json'), 'utf8'));
    assert.equal(saved.status, 'failed');
    assert.ok(saved.finishedAt);
    lookups.length = 0;
    f.ctx.jobs.kill = () => { throw new Error('A finished job must not be cancelled.'); };
    assert.equal((await f.workspace.cancel({ id: completed.id })).status, 'completed');
    assert.equal((await f.workspace.cancel({ id: orphanId })).status, 'failed');
    const reopened = createWorkspace(f.ctx, async () => { throw new Error('Unexpected model work'); }, { home: f.home });
    assert.equal((await reopened.getTask(orphanId)).finishedAt, saved.finishedAt);
    assert.deepEqual(lookups, []);
  } finally { f.release(); await nativeGet(active.id).hooks.done; }
});

test('task reconciliation does not suppress native job ownership or other registry errors', async t => {
  const f = await fixture(t); f.block();
  const task = await f.workspace.start({ action: 'analyze', libraryId: f.item.id });
  await until(() => f.requests.some(request => request.action === 'analyze'));
  const nativeJob = f.ctx.jobs.get(task.id);
  try {
    for (const message of [`job ${task.id} belongs to another session`, 'Registry read failed.']) {
      f.ctx.jobs.get = () => { throw new Error(message); };
      await assert.rejects(f.workspace.getTask(task.id), error => error.message === message);
      await assert.rejects(f.workspace.tasks(), error => error.message === message);
      assert.equal(JSON.parse(await readFile(join(f.home, 'skillnet/tasks', task.id + '.json'), 'utf8')).status, 'running');
    }
  } finally { f.release(); await nativeJob.hooks.done; }
});

test('routing rejects stale analyses and unconnected libraries before model work', async t => {
  const f = await fixture(t, undefined, [{ id: 'fixture' }]); f.stale();
  await assert.rejects(f.workspace.start({ action: 'route', retrievalMode: 'vector', libraryId: f.item.id, query: 'process data' }), /重新建图/);
  await assert.rejects(f.workspace.start({ action: 'analyze', sourcePath: join(f.home, 'unconnected') }), /连接/);
  assert.equal(f.requests.some(r => r.action === 'route'), false);
});

test('owned jobs do not leak into another Agent task list', async t => {
  const f = await fixture(t);
  const task = await f.workspace.start({ action: 'analyze', libraryId: f.item.id }, { agent: { id: 'session-one' } });
  await f.ctx.jobs.get(task.id, 'session-one').hooks.done;
  assert.equal((await f.workspace.tasks({}, 'session-two')).items.length, 0);
  await assert.rejects(f.workspace.getTask(task.id, 'session-two'), /不属于/);
});

test('host create needs no independent API and does not send saved model credentials to Python', async t => {
  const host = { capture: async execution => ({ selection: execution.agent.model.current(), sessionId: execution.agent.id }) };
  const f = await fixture(t, host);
  await f.workspace.settings({ values: {}, clearSecrets: ['api_key', 'explorer_api_key', 'embedding_api_key'] });
  const agent = { id: 'current', model: { current: () => ({ provider: 'host', model: 'chosen-model' }) } };
  const task = await f.workspace.start({ action: 'create', content: '创建数据检查技能' }, { agent });
  await f.ctx.jobs.get(task.id, agent.id).hooks.done;
  const request = f.requests.find(req => req.action === 'create');
  assert.equal(request._host_model.model, 'chosen-model');
  assert.equal(request._settings.api_key, undefined);
  assert.equal(request._settings.explorer_api_key, undefined);
  assert.equal((await f.workspace.getTask(task.id)).status, 'completed');
});

test('route use verifies effective native path, queues the target dialogue, and rejects stale analysis', async t => {
  const agent = { id: 'target' }; let queued = 0;
  const host = { agentFor: async () => agent, use: async selection => { queued++; assert.equal(selection.query, '处理数据'); return { accepted: true }; } };
  const skills = [];
  const f = await fixture(t, host, skills);
  const path = join(f.path, 'fixture'); await mkdir(path);
  await writeFile(join(path, 'SKILL.md'), 'fixture');
  skills.push({ id: 'fixture', name: 'fixture', path });
  f.ctx.workingDirectory = { ensure: async who => { assert.equal(who, agent); return f.path; } };
  const id = 'skillnet-route-abcd';
  await mkdir(join(f.home, 'skillnet/tasks'), { recursive: true });
  await writeFile(join(f.home, 'skillnet/tasks', id + '.json'), JSON.stringify({ id, action: 'route', status: 'completed', startedAt: new Date().toISOString(), libraryId: f.item.id, query: '处理数据', result: { skills: [{ skill_id: 'fixture', name: 'fixture' }] } }));
  let effective = false;
  const native = { get: async (_name, options) => { assert.equal(options.scope, agent); return { path: effective ? join(path, 'SKILL.md') : join(f.home, 'shadow/SKILL.md'), invocation: { modelInvocable: true } }; } };
  f.useNative(native);
  assert.equal((await f.workspace.useRoute({ id, sessionId: 'target' })).accepted, false);
  assert.equal(queued, 0);
  effective = true;
  assert.equal((await f.workspace.useRoute({ id, sessionId: 'target' })).accepted, true);
  assert.equal(queued, 1);
  f.profiles(['pending']);
  await assert.rejects(f.workspace.useRoute({ id, sessionId: 'target' }), /索引缺少部分技能画像/);
  f.profiles([]);
  f.stale();
  await assert.rejects(f.workspace.useRoute({ id, sessionId: 'target' }), /重新建图/);
  assert.equal(queued, 1);
});

test('route-draft prepares the selected result for the requested dialogue without sending it', async t => {
  const agent = { id: 'target-dialogue' };
  const host = {
    agentFor: async id => { assert.equal(id, agent.id); return agent; },
    use: async () => assert.fail('Preparing a route draft sent a follow-up.'),
  };
  const skills = [];
  const f = await fixture(t, host, skills);
  const sourcePath = join(f.home, 'reports');
  const path = join(sourcePath, 'fixture');
  const expectedPath = join(path, 'SKILL.md');
  const shadowPath = join(f.home, 'project', 'fixture', 'SKILL.md');
  await mkdir(path, { recursive: true }); await writeFile(expectedPath, 'fixture');
  skills.push({ id: 'fixture', name: 'fixture', path: expectedPath });
  const item = (await f.workspace.connect({ sourcePath })).connection;
  const id = 'skillnet-route-abd0';
  await createTaskStore(join(f.home, 'skillnet')).write({ id, action: 'route', retrievalMode: 'vector', status: 'completed',
    startedAt: new Date().toISOString(), libraryId: item.id, query: '检查报表再生成看板',
    result: { skills: [{ skill_id: 'fixture', name: 'fixture' }] } });
  let nativePath = shadowPath;
  f.ctx.workingDirectory = { ensure: async scope => { assert.equal(scope, agent); return f.path; } };
  f.useNative({ get: async (name, { cwd, scope }) => {
    assert.equal(name, 'fixture'); assert.equal(cwd, f.path); assert.equal(scope, agent);
    return { path: nativePath, invocation: { userInvocable: false, modelInvocable: true } };
  } });
  await assert.rejects(f.workspace.routeDraft({ id }), /选择要使用的 DSH 对话/);
  const args = { id, sessionId: agent.id };
  const blocked = await f.workspace.routeDraft(args);
  assert.equal(blocked.ready, false); assert.equal(blocked.code, 'native_path_mismatch');
  assert.equal(blocked.actualPath, shadowPath); assert.equal(blocked.skillId, 'fixture');
  assert.equal(blocked.sourcePath, sourcePath);
  assert.deepEqual(blocked.preview.origin, { libraryId: item.id, skillId: 'fixture' });
  const diagnosis = await f.workspace.routeDraft({ ...args, preview: false });
  assert.equal(diagnosis.code, blocked.code); assert.equal(diagnosis.preview, undefined);
  nativePath = expectedPath;
  const draft = await f.workspace.routeDraft(args);
  assert.equal(draft.ready, true);
  assert.equal(draft.sessionId, agent.id);
  assert.match(draft.prompt, /reports/); assert.match(draft.prompt, /fixture/); assert.match(draft.prompt, /检查报表再生成看板/);
  f.stale();
  await assert.rejects(f.workspace.routeDraft(args), /重新建图/);
});

test('failed custom-index reads do not commit, and source-only reconnect preserves the saved index', async t => {
  const f = await fixture(t);
  const valid = join(f.home, 'custom-index'); const invalid = join(f.home, 'invalid');
  await mkdir(valid); await mkdir(invalid);
  await f.workspace.connect({ sourcePath: f.path, indexPath: valid });
  await assert.rejects(f.workspace.connect({ sourcePath: f.path, indexPath: invalid }), /invalid analysis/);
  assert.equal((await f.workspace.listLibraries())[0].indexPath, valid);
  await f.workspace.connect({ sourcePath: f.path });
  assert.equal((await f.workspace.listLibraries())[0].indexPath, valid);
  assert.equal(f.requests.filter(r => r.action === 'local-library').at(-1).indexPath, valid);
});

test('analysis and evaluation use the selected DSH model without independent chat credentials', async t => {
  const captured = [];
  const host = { capture: async (_execution, sessionId) => { captured.push(sessionId); return { selection: { provider: 'host', model: 'chosen-model' }, sessionId }; } };
  const skills = [];
  const f = await fixture(t, host, skills);
  const path = join(f.path, 'fixture'); await mkdir(path);
  await writeFile(join(path, 'SKILL.md'), 'fixture'); skills.push({ id: 'fixture', path });
  await f.workspace.settings({ values: {}, clearSecrets: ['api_key', 'explorer_api_key'] });
  for (const action of ['analyze', 'evaluate']) {
    const task = await f.workspace.start({ action, libraryId: f.item.id, skillId: 'fixture', sessionId: 'selected-dialogue' });
    await f.ctx.jobs.get(task.id).hooks.done;
    assert.equal((await f.workspace.getTask(task.id)).model.model, 'chosen-model');
    if (action === 'evaluate') {
      assert.equal((await f.workspace.getTask(task.id)).skillId, 'fixture');
      assert.equal((await f.workspace.tasks({ action, skillId: 'fixture' })).items.length, 1);
      assert.equal((await f.workspace.tasks({ action, skillId: 'another-skill' })).items.length, 0);
    }
    const request = f.requests.findLast(item => item.action === action);
    assert.equal(request._host_model.model, 'chosen-model');
    assert.equal(request._settings.api_key, undefined);
    assert.equal(request._settings.explorer_api_key, undefined);
  }
  assert.deepEqual(captured, ['selected-dialogue', 'selected-dialogue']);
  await assert.rejects(f.workspace.start({ action: 'analyze', libraryId: f.item.id, modelSource: 'sdk' }), /API/);
});

test('default DSH analysis and routing need no embedding settings; vector mode still requires them', async t => {
  const host = { capture: async () => ({ selection: { provider: 'host', model: 'current' } }) };
  const skills = []; const f = await fixture(t, host, skills);
  const path = join(f.path, 'fixture'); await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'fixture'); skills.push({ id: 'fixture', path });
  await f.workspace.settings({ values: {}, clearSecrets: ['api_key', 'explorer_api_key', 'embedding_api_key'] });
  const task = await f.workspace.start({ action: 'evaluate', libraryId: f.item.id, skillId: 'fixture' });
  await f.ctx.jobs.get(task.id).hooks.done;
  assert.equal((await f.workspace.getTask(task.id)).status, 'completed');
  for (const action of ['analyze', 'route']) {
    const task = await f.workspace.start({ action, libraryId: f.item.id, query: 'CSV' });
    assert.equal((await f.workspace.tasks({ action, sourcePath: f.path })).items[0].id, task.id);
    await f.ctx.jobs.get(task.id).hooks.done;
    assert.equal((await f.workspace.getTask(task.id)).retrievalMode, 'model');
    assert.equal(f.requests.findLast(item => item.action === action).retrievalMode, 'model');
    await assert.rejects(f.workspace.start({ action, retrievalMode: 'vector', libraryId: f.item.id, query: 'CSV' }), /向量模型/);
  }
  f.graph(null);
  const route = await f.workspace.start({ action: 'route', libraryId: f.item.id, query: 'CSV' });
  await f.ctx.jobs.get(route.id).hooks.done;
  assert.equal((await f.workspace.getTask(route.id)).status, 'completed');
  await assert.rejects(f.workspace.start({ action: 'route', retrievalMode: 'vector', libraryId: f.item.id, query: 'CSV' }), /向量检索.*建图/);
  f.graph({ embedding_model: '' });
  await assert.rejects(f.workspace.start({ action: 'route', retrievalMode: 'vector', libraryId: f.item.id, query: 'CSV' }), /不含向量索引/);
  await assert.rejects(f.workspace.start({ action: 'analyze', retrievalMode: 'unknown', libraryId: f.item.id }), /模式/);
});

test('model route handoff works without a graph and refuses changed, added or removed sources', async t => {
  let used = 0;
  const host = { agentFor: async () => ({ id: 'target' }), use: async () => { used++; return { accepted: true } } };
  const skills = []; const f = await fixture(t, host, skills); f.graph(null);
  const path = join(f.path, 'fixture'); await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'fixture');
  skills.push({ id: 'fixture', name: 'fixture', path, source: 'fixture\n' });
  f.ctx.workingDirectory = { ensure: async () => f.path };
  const id = 'skillnet-route-abce';
  await mkdir(join(f.home, 'skillnet/tasks'), { recursive: true });
  const versions = { fixture: createHash('sha256').update('fixture\n').digest('hex') };
  await writeFile(join(f.home, 'skillnet/tasks', id + '.json'), JSON.stringify({ id, action: 'route', retrievalMode: 'model', status: 'completed', startedAt: new Date().toISOString(), libraryId: f.item.id, query: '处理数据', result: { skills: [{ skill_id: 'fixture', name: 'fixture' }], source_versions: versions } }));
  const native = { get: async () => ({ path: join(path, 'SKILL.md'), invocation: { modelInvocable: true } }) };
  f.useNative(native);
  assert.equal((await f.workspace.useRoute({ id })).accepted, true);
  skills[0].source = 'changed';
  await assert.rejects(f.workspace.useRoute({ id }), /重新运行路由/);
  skills[0].source = 'fixture\n'; skills.push({ id: 'new', source: 'new' });
  await assert.rejects(f.workspace.useRoute({ id }), /重新运行路由/);
  skills.splice(0);
  await assert.rejects(f.workspace.useRoute({ id }), /重新运行路由/);
  assert.equal(used, 1);
});

test('preparing a skill draft checks user invocation and the effective path without sending or inference', async t => {
  const agent = { id: 'chosen-dialogue' }; const sent = [];
  const host = {
    agentFor: async sessionId => { assert.equal(sessionId, 'chosen-dialogue'); return agent },
    use: async () => { throw new Error('Preparing a draft must never send a message.'); },
  };
  const skills = []; const f = await fixture(t, host, skills); f.graph(null);
  const sourcePath = join(f.home, 'reports');
  const path = join(sourcePath, 'fixture'); await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), 'fixture');
  skills.push({ id: 'fixture', name: 'fixture', path: join(path, 'SKILL.md'), source: 'fixture' });
  const reports = (await f.workspace.connect({ sourcePath })).connection;
  f.ctx.workingDirectory = { ensure: async scope => { assert.equal(scope, agent); return f.path } };
  let effective = true, callable = true;
  const native = { get: async (name, options) => {
    assert.equal(name, 'fixture'); assert.equal(options.scope, agent); assert.equal(options.cwd, f.path);
    return { path: effective ? join(path, 'SKILL.md') : join(f.home, 'shadow/SKILL.md'), invocation: { userInvocable: callable, modelInvocable: false } };
  } };
  f.useNative(native);
  f.requests.splice(0);
  const args = { sourcePath, skillId: 'fixture', sessionId: 'chosen-dialogue', query: '画论文图' };
  const prepared = await f.workspace.useSkill(args);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.reference, '/fixture ');
  assert.equal(prepared.sessionId, 'chosen-dialogue');
  assert.deepEqual(prepared.skill, { name: 'fixture', path: join(path, 'SKILL.md'), userInvocable: true, modelInvocable: false });
  assert.equal(Object.hasOwn(prepared, 'query'), false);
  assert.equal((await f.workspace.useSkill({ ...args, query: '' })).reference, '/fixture ');
  for (const state of ['shadowed', 'disabled']) {
    effective = state !== 'shadowed'; callable = state !== 'disabled';
    const result = await f.workspace.useSkill(args);
    assert.equal(result.ready, false);
    if (state === 'shadowed') {
      assert.equal(result.code, 'native_path_mismatch');
      assert.equal(result.preview.path, path);
      assert.deepEqual(result.preview.origin, { libraryId: reports.id, skillId: 'fixture' });
      assert.equal((await f.workspace.useSkill({ ...args, preview: false })).preview, undefined);
    } else {
      assert.equal(result.code, 'native_not_invocable');
      assert.equal(result.preview, undefined);
    }
  }
  assert.equal(sent.length, 0);
  await assert.rejects(f.workspace.useSkill({ ...args, skillId: '../outside' }), /不在当前库/);
  await assert.rejects(f.workspace.useSkill({ ...args, sourcePath: f.home }), /连接/);
  skills.splice(0);
  await assert.rejects(f.workspace.useSkill(args), /已不在当前库/);
  assert.ok(f.requests.every(request => request.action === 'local-library'));
  assert.equal((await f.workspace.tasks()).items.length, 0);
});
