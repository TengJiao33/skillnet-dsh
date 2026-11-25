import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackend } from '../src/backend.js';
import { createHostModel } from '../src/host-model.js';

const subprocess = {
  resolveExecutable: async value => value,
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal });
    child.stderr.resume();
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    return { stdin: child.stdin, stdout: child.stdout, done, terminate: async () => { if (child.exitCode === null) child.kill() }, waitForExit: () => done };
  },
};

test('stock SkillNet creator uses the host pipe without a model API key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-host-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const result = await createBackend(subprocess)({ action: 'create', input_type: 'prompt', prompt: '生成 CSV 检查技能', output_dir: root, _host_model: { provider: 'fixture', model: 'current-session-model' } }, undefined, async payload => {
    seen.push(payload);
    return { content: '## FILE: csv-host-check/SKILL.md\n```markdown\n---\nname: csv-host-check\ndescription: 检查 CSV 缺失值\n---\n# 检查 CSV\n读取 CSV，报告缺失值，不修改输入。\n```\n' };
  });
  assert.equal(seen.length, 1); assert.equal(seen[0].method, 'chat');
  assert.equal(result.drafts[0].validation.valid, true);
  assert.match(await readFile(join(root, 'csv-host-check/SKILL.md'), 'utf8'), /检查 CSV/);
});

test('host selection prefers the calling Agent and constrained operations cannot read outside Wiki', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-host-model-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'wiki'); await mkdir(wiki); await writeFile(join(wiki, 'index.md'), 'candidate wiki'); await writeFile(join(root, 'outside.txt'), 'outside');
  const calls = [], sessions = new Map(); let tools, guard;
  const ctx = {
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default-model' }) },
    sessions: { get: id => sessions.get(id) },
    agents: { list: () => [], get: () => undefined, async create(args) {
      tools = new Map(); calls.push(args.agentOptions);
      const scope = { systemPrompt: { section() {} }, tools: { restrict(mask) { assert.deepEqual(mask, { allow: [] }) }, guard(fn) { guard = fn }, register(def) { tools.set(def.name, def) } }, on() {} };
      args.setup(scope);
      sessions.set(args.sessionId, { snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"skills":[]}' }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }] });
      return { agent: { followup: async message => {
        assert.equal(message.role, 'user'); assert.match(message.id, /^[0-9a-f-]{36}$/);
        assert.deepEqual(message.content, [{ type: 'text', text: 'route task' }]);
      }, whenIdle: async () => {}, cancel() {} }, dispose: async () => {} };
    } },
  };
  const model = createHostModel(ctx);
  const selected = await model.capture({ agent: { id: 'parent', model: { current: () => ({ provider: 'current', model: 'selected-model' }) } } });
  assert.equal(selected.selection.model, 'selected-model');
  await model.invoke(selected, { method: 'explore', root: wiki, system: 'read wiki', prompt: 'route task', max_turns: 5 }, AbortSignal.timeout(1000));
  assert.equal(calls[0].provider, 'current'); assert.ok(guard({ name: 'exec_command' }));
  assert.equal(Object.hasOwn(calls[0], 'maxTokens'), false);
  assert.equal(await tools.get('read_wiki').execute({ path: 'index.md' }, { signal: AbortSignal.timeout(1000) }), 'candidate wiki');
  await assert.rejects(tools.get('read_wiki').execute({ path: '../outside.txt' }, { signal: AbortSignal.timeout(1000) }), /Wiki 以外/);
});

test('cancellation during task persistence never starts a new model turn', async () => {
  const controller = new AbortController(); let starts = 0, disposed = 0;
  const model = createHostModel({ agents: { async create() { return { agent: { followup: async () => { starts++ }, cancel() {}, whenIdle: async () => {} }, dispose: async () => { disposed++ } }; } } });
  await assert.rejects(model.invoke({ selection: { provider: 'fixture', model: 'fixture' } }, { method: 'chat', system: 'test', prompt: 'test' }, controller.signal, async () => controller.abort()), /abort/i);
  assert.equal(starts, 0); assert.equal(disposed, 1);
});

test('relation review selects only supported efforts in low, off, then original order', async () => {
  const original = { selection: { provider: 'custom', model: 'same-model', reasoningEffort: 'high' }, sessionId: 'parent' };
  const signal = AbortSignal.timeout(1000);
  for (const [levels, expected] of [
    [['off', 'high', 'low'], 'low'], [['off', 'high'], 'off'], [['high', 'max'], 'high'], [[], 'high'],
  ]) {
    const host = createHostModel({ llm: { async resolveModelInfo(provider, model, requestedSignal) {
      assert.deepEqual([provider, model, requestedSignal], ['custom', 'same-model', signal]);
      return levels.length ? { reasoning: { efforts: levels.map(id => ({ id })) } } : {};
    } } });
    const selected = await host.forRelationReview(original, signal);
    assert.deepEqual(selected, { ...original, selection: { ...original.selection, reasoningEffort: expected } });
    assert.equal(original.selection.reasoningEffort, 'high');
  }
  const unconfigured = createHostModel({});
  const providerDefault = { selection: { provider: 'custom', model: 'same-model' } };
  assert.equal(await unconfigured.forRelationReview(providerDefault), providerDefault);
  await assert.rejects(unconfigured.forRelationReview(original, AbortSignal.abort()), /abort/i);
});

test('conversation extraction is explicit, bounded, and never resumes a cold session', async () => {
  let resumed = 0;
  const messages = [{ role: 'system', content: [{ type: 'text', text: 'private system' }] }, { role: 'tool', content: [{ type: 'text', text: 'private tool' }] }, ...Array.from({ length: 26 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: i === 25 ? 'api_key=secret-fixture-value' : `任务消息 ${i}` }] }))];
  const model = createHostModel({ get: () => ({ resume: () => { resumed++ } }), agents: { get: id => id === 'open' ? { id } : undefined }, sessions: { get: () => ({ deriveMessages: () => messages }) } });
  const result = await model.conversation('open');
  assert.equal(result.count, 24); assert.equal(result.limited, true);
  assert.doesNotMatch(result.content, /private system|private tool|secret-fixture-value/);
  await assert.rejects(model.conversation('cold'), /先在 DSH 打开/);
  assert.equal(resumed, 0);
});

test('host inference respects the SDK call deadline and disposes the child Agent', async () => {
  let stop; let cancelled = 0; let disposed = 0;
  const idle = new Promise(resolve => { stop = resolve; });
  const model = createHostModel({ agents: { async create() {
    return { agent: { followup: async () => {}, whenIdle: () => idle, cancel() { cancelled++; stop(); } }, dispose: async () => { disposed++; } };
  } } });
  await assert.rejects(model.invoke({ selection: { provider: 'fixture', model: 'fixture' } }, { method: 'chat', system: 'deadline', prompt: 'fixture', label: '提取画像：citation-management', timeout_ms: 50 }), error => error.name === 'TimeoutError' && /提取画像：citation-management.*模型调用超时/.test(error.message));
  assert.equal(cancelled, 1); assert.equal(disposed, 1);
});

test('DSH sidebar titles come from current session title projections, including renames', async () => {
  let title = '论文绘图';
  const agent = { id: 'session-uuid', session: { header: { cwd: 'C:/workspace' } }, model: { current: () => ({ provider: 'fixture', model: 'current' }) } };
  const model = createHostModel({
    get: name => name === 'sessionController' ? { list: async () => ({ items: [{ sessionId: agent.id, title: 'outdated', projections: { kind: 'sequenced', values: { title } } }] }) } : undefined,
    agents: { list: () => [agent] }, agentDefaultModel: { currentSelection: () => null },
  });
  assert.equal((await model.contexts()).sessions[0].title, '论文绘图');
  title = '新版对话标题';
  assert.equal((await model.contexts()).sessions[0].title, '新版对话标题');
  assert.equal((await model.contexts()).sessions[0].sessionId, 'session-uuid');
});

test('direct use sends an identified user message to the chosen dialogue', async () => {
  const messages = [];
  const model = createHostModel({ agents: { get: id => id === 'target' ? { id, followup: async message => messages.push(message) } : undefined } });
  await model.use({ query: '画图', skills: [{ name: 'figure' }] }, 'target');
  await model.use({ query: '画图', skills: [{ name: 'figure' }] }, 'target');
  assert.equal(messages[0].role, 'user'); assert.match(messages[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.match(messages[0].content[0].text, /画图/);
});

test('model failures retain the actual DSH code and redact credentials instead of pointing at job history', async () => {
  const model = createHostModel({
    agents: { create: async () => ({ agent: { followup: async message => { assert.equal(message.role, 'user') }, whenIdle: async () => {}, cancel() {} }, dispose: async () => {} }) },
    sessions: { get: () => ({ snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed api_key=sk-fixture-private' } } } }] }) },
  });
  await assert.rejects(model.invoke({ selection: { provider: 'fixture', model: 'chosen-model' } }, { method: 'chat', system: 'schema', prompt: 'task' }, AbortSignal.timeout(1000)), error => {
    assert.match(error.message, /chosen-model.*TRANSPORT/);
    assert.match(error.message, /DeepSeek Messages transport failed/);
    assert.doesNotMatch(error.message, /sk-fixture-private|作业记录/);
    return true;
  });
});

test('real DSH chunk wrappers preserve truncated-output detection', async () => {
  const model = createHostModel({
    agents: { create: async () => ({ agent: { followup: async () => {}, whenIdle: async () => {}, cancel() {} }, dispose: async () => {} }) },
    sessions: { get: () => ({ snapshotEvents: () => [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"partial":' }] }, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] } },
      { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
    ] }) },
  });
  const selection = { selection: { provider: 'fixture', model: 'current' } };
  const request = { method: 'chat', system: 'schema', prompt: 'task' };
  await assert.rejects(model.invoke(selection, request, AbortSignal.timeout(1000)), /结果被截断/);
  const response = await model.invoke(selection, { ...request, expect_json: true }, AbortSignal.timeout(1000));
  assert.equal(response.content, '');
  assert.equal(response.truncated, true);
  const batch = await model.invoke(selection, { ...request, expect_json: true, format: 'relation-lines' }, AbortSignal.timeout(1000));
  assert.equal(batch.content, '{"partial":');
  assert.equal(batch.truncated, true);
});
