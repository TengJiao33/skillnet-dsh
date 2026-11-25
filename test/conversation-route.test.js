import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspace } from '../src/workspace.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-conversation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'skills');
  const skills = [];
  for (const name of ['csv-summary', 'csv-check']) {
    const file = join(path, name, 'SKILL.md'); await mkdir(join(path, name), { recursive: true });
    const source = `---\nname: ${name}\ndescription: Work on CSV data.\n---\nKeep the original input.\n`;
    await writeFile(file, source); skills.push({ id: name, name, path: file, source });
  }
  const controller = new AbortController(), agent = { id: 'current-dialogue' };
  const execution = { agent, signal: controller.signal };
  const selection = { provider: 'current-provider', model: 'current-model' };
  const loads = [], requests = [];
  let mode = 'ok', nativeMode = 'ok', selected = ['csv-summary', 'csv-check'], graph = null;
  const ctx = {
    credentials: { resolve: () => undefined },
    workingDirectory: { ensure: async scope => { assert.equal(scope, agent); return home; } },
    tools: { async execute(batch) {
      assert.equal(batch.agent, agent); assert.equal(batch.signal, execution.signal);
      const call = batch.calls[0]; assert.equal(call.name, 'skill');
      const { name } = JSON.parse(call.arguments); loads.push(name);
      return { results: [{ result: mode === 'load-error' ? { isError: true } : { isError: false, value: { name, content: 'Full native instructions.' }, content: [{ type: 'text', text: `<skill_content name="${name}">Full native instructions.</skill_content>` }] } }] };
    } },
    jobs: { start() { throw new Error('Conversation routing must not allocate a detached job.'); } },
  };
  const host = {
    capture: async caller => { assert.equal(caller, execution); return { selection, sessionId: agent.id }; },
    invoke: async (_model, _payload, signal) => {
      if (mode === 'cancel') { controller.abort(); signal.throwIfAborted(); }
      return { content: 'Selection.' };
    },
    use() { throw new Error('Must continue the same tool turn, without sending another user message.'); },
  };
  const run = async (request, signal, invoke) => {
    requests.push(request);
    if (request.action === 'settings') return { fields: {} };
    if (request.action === 'local-library') return { source: { skills }, graph, analysisError: null, changedSkills: 0, addedSkills: 0, removedSkills: 0 };
    assert.equal(request.action, 'route'); assert.deepEqual(request._host_model, selection);
    assert.ok(invoke); await invoke({ method: 'explore' }, signal);
    const result = { skills: selected.map(skill_id => ({ skill_id, name: skill_id, reason: 'Relevant to the original task.' })), source_versions: Object.fromEntries(skills.map(s => [s.id, createHash('sha256').update(s.source).digest('hex')])) };
    if (mode === 'stale') skills[0].source += 'Changed during inference.';
    return result;
  };
  const native = { get: async (name, options) => {
    assert.equal(options.scope, agent); assert.equal(options.cwd, home);
    return { path: nativeMode === 'shadowed' ? join(home, 'project', name, 'SKILL.md') : skills.find(skill => skill.name === name).path, invocation: { modelInvocable: nativeMode !== 'disabled' } };
  } };
  const workspace = createWorkspace(ctx, run, { home }, host);
  return { home, workspace, execution, controller, requests, loads, native,
    mode: value => { mode = value; }, nativeMode: value => { nativeMode = value; }, selected: value => { selected = value; }, graph: value => { graph = value; } };
}

test('conversation routing connects the default library, inherits the caller model and loads native skills in the same turn', async t => {
  const f = await fixture(t);
  const result = await f.workspace.routeConversation({ query: '检查原数据，再给出汇总结果；保留输入文件。' }, f.execution, f.native);
  assert.equal(result.query, '检查原数据，再给出汇总结果；保留输入文件。');
  assert.deepEqual(f.loads, ['csv-summary', 'csv-check']);
  assert.equal(result.loaded.length, 2); assert.match(result.loaded[0].content[0].text, /Full native instructions/);
  assert.match(result.next, /继续执行/);
  assert.equal(f.requests.find(request => request.action === 'route').retrievalMode, 'model');
  const library = (await f.workspace.listLibraries())[0];
  assert.equal(library.sourcePath, join(f.home, 'skills'));
  assert.deepEqual(result.library, { id: library.id, name: library.name });
  await f.workspace.routeConversation({ query: 'another task', libraryId: library.id }, f.execution, f.native);
  await assert.rejects(f.workspace.routeConversation({ query: 'task', libraryId: 'unknown' }, f.execution, f.native), /连接/);
});

test('recommendation-only routing returns library picks even when native skills are unavailable', async t => {
  const f = await fixture(t);
  const args = { query: '只返回技能 ID', loadSkills: false };
  const unavailable = { get: () => assert.fail('Recommendation looked up a native skill') };
  const result = await f.workspace.routeConversation(args, f.execution, unavailable);
  const [library] = await f.workspace.listLibraries();
  assert.deepEqual(result.library, { id: library.id, name: library.name });
  assert.deepEqual(result.skills.map(skill => skill.skill_id), ['csv-summary', 'csv-check']);
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(f.loads, []);
  f.mode('stale');
  await assert.rejects(f.workspace.routeConversation(args, f.execution, unavailable), /重新运行路由/);
});

test('no suitable skill continues the task without loading, installing or inventing one', async t => {
  const f = await fixture(t); f.selected([]);
  const result = await f.workspace.routeConversation({ query: '无匹配的任务' }, f.execution, f.native);
  assert.deepEqual(result.skills, []); assert.deepEqual(result.loaded, []); assert.deepEqual(f.loads, []);
  assert.match(result.next, /继续处理原任务/);
});

test('conversation routing refuses stale sources, shadowed or disabled skills and failed native loading', async t => {
  for (const state of ['stale', 'shadowed', 'disabled', 'load-error']) {
    const f = await fixture(t);
    if (['shadowed', 'disabled'].includes(state)) f.nativeMode(state); else f.mode(state);
    await assert.rejects(f.workspace.routeConversation({ query: 'task' }, f.execution, f.native), /重新运行路由|当前对话生效|未能.*加载/);
    if (state !== 'load-error') assert.deepEqual(f.loads, []);
  }
});

test('conversation routing requires a caller and cancellation stops inference before any skill load', async t => {
  const f = await fixture(t);
  await assert.rejects(f.workspace.routeConversation({ query: 'task' }, { signal: f.execution.signal }, f.native), /当前 DSH 对话/);
  f.mode('cancel');
  await assert.rejects(f.workspace.routeConversation({ query: 'task' }, f.execution, f.native), { name: 'AbortError' });
  assert.deepEqual(f.loads, []);
});

test('conversation vector routing keeps the original graph and embedding prerequisites', async t => {
  const f = await fixture(t);
  const route = () => f.workspace.routeConversation({ query: 'task', retrievalMode: 'vector' }, f.execution, f.native);
  await assert.rejects(route(), /向量检索.*建图/);
  f.graph({ embedding_model: '' }); await assert.rejects(route(), /不含向量索引/);
  f.graph({ embedding_model: 'configured-embedding' }); await assert.rejects(route(), /配置/);
  assert.deepEqual(f.loads, []);
});
