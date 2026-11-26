import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply } from '../src/index.js';
import { createLibrary } from '../src/library.js';
import { createWorkspace } from '../src/workspace.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'skillnet-conversation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'skills');
  const skills = [];
  for (const name of ['csv-summary', 'csv-check', 'csv-archive']) {
    const file = join(path, name, 'SKILL.md'); await mkdir(join(path, name), { recursive: true });
    const source = `---\nname: ${name}\ndescription: Work on CSV data.\n---\nKeep the original input.\n`;
    await writeFile(file, source); skills.push({ id: name, name, path: file, source });
  }
  const controller = new AbortController(), agent = { id: 'current-dialogue' };
  const execution = { agent, signal: controller.signal };
  const selection = { provider: 'current-provider', model: 'current-model' };
  const loads = [], requests = [], lookups = [];
  const messages = [{ id: 'request', role: 'user', source: { kind: 'user' } }];
  let mode = 'ok', nativeMode = 'ok', selected = ['csv-summary', 'csv-check'], graph = null, pendingProfiles = [];
  let fields = {};
  let selectLibraries;
  const sources = new Map([[path, skills]]);
  const localSkill = name => [...sources.values()].flat().find(skill => skill.name === name);
  async function connect(name, names) {
    const sourcePath = join(home, name);
    const entries = [];
    for (const skillName of names) {
      const folder = join(sourcePath, skillName);
      const path = join(folder, 'SKILL.md');
      const source = '# ' + skillName;
      await mkdir(folder, { recursive: true });
      await writeFile(path, source);
      entries.push({ id: skillName, name: skillName, path, source, description: skillName });
    }
    sources.set(sourcePath, entries);
    return (await workspace.connect({ sourcePath })).connection;
  }
  const ctx = {
    credentials: { resolve: () => undefined },
    sessions: { get(id) { assert.equal(id, agent.id); return { deriveMessages: () => messages }; } },
    workingDirectory: { ensure: async scope => {
      assert.equal(scope, agent);
      if (mode === 'scope-error') throw new Error('Internal scope details');
      return home;
    } },
    tools: { async execute(batch) {
      assert.equal(batch.agent, agent); assert.equal(batch.signal, execution.signal);
      const call = batch.calls[0]; assert.equal(call.name, 'skill');
      const { name } = JSON.parse(call.arguments); loads.push(name);
      if (mode === 'load-throw') throw new Error('Internal tool details');
      const failed = mode === 'load-error' || mode === 'second-load-error' && name === 'csv-check';
      const resourceBase = { kind: 'directory', path: mode === 'wrong-resource' ? join(path, 'shadow') : dirname(localSkill(name).path) };
      return { results: [{ result: failed ? { isError: true } : { isError: false, value: { name, resourceBase, content: 'Full native instructions.' }, content: [{ type: 'text', text: `<skill_content name="${name}">Full native instructions.</skill_content>` }] } }] };
    } },
    jobs: { start() { throw new Error('Conversation routing must not allocate a detached job.'); } },
  };
  const host = {
    capture: async caller => { assert.equal(caller, execution); return { selection, sessionId: agent.id }; },
    invoke: async (_model, payload, signal) => {
      if (mode === 'cancel') { controller.abort(); signal.throwIfAborted(); }
      return payload.root && selectLibraries ? selectLibraries(payload) : { content: 'Selection.' };
    },
    use() { throw new Error('Must continue the same tool turn, without sending another user message.'); },
  };
  const run = async (request, signal, invoke) => {
    requests.push(request);
    if (request.action === 'settings') return { fields };
    const entries = sources.get(request.sourcePath) || skills;
    if (request.action === 'local-library') return { source: { skills: entries }, graph, pendingProfiles, analysisError: null, changedSkills: 0, addedSkills: 0, removedSkills: 0 };
    assert.equal(request.action, 'route'); assert.deepEqual(request._host_model, selection);
    assert.ok(invoke); await invoke({ method: 'explore' }, signal);
    const result = { skills: selected.map(skill_id => ({ skill_id, name: skill_id, reason: 'Relevant to the original task.' })), source_versions: Object.fromEntries(entries.map(s => [s.id, createHash('sha256').update(s.source).digest('hex')])) };
    if (mode === 'stale') skills[0].source += 'Changed during inference.';
    return result;
  };
  const native = { get: async (name, options) => {
    assert.equal(options.scope, agent); assert.equal(options.cwd, home);
    lookups.push(name);
    if (nativeMode === 'missing' || nativeMode === 'mixed' && name === 'csv-summary') return null;
    if (nativeMode === 'error') throw new Error('Internal lookup details');
    return { name, path: nativeMode === 'shadowed' ? join(home, 'project', name, 'SKILL.md') : localSkill(name).path,
      invocation: { modelInvocable: nativeMode !== 'disabled' && !(nativeMode === 'mixed' && name === 'csv-check') } };
  } };
  const library = createLibrary(run, native, { dshHome: home });
  const workspace = createWorkspace(ctx, run, library, host);
  return { home, workspace, execution, controller, requests, loads, lookups, messages, connect,
    selectLibraries: value => { selectLibraries = value; },
    mode: value => { mode = value; }, nativeMode: value => { nativeMode = value; }, selected: value => { selected = value; }, graph: value => { graph = value; },
    profiles: value => { pendingProfiles = value; }, settings: value => { fields = value; } };
}

test('conversation routing connects the default library, inherits the caller model and loads native skills in the same turn', async t => {
  const f = await fixture(t);
  const result = await f.workspace.routeConversation({ query: '检查原数据，再给出汇总结果；保留输入文件。' }, f.execution);
  assert.equal(result.query, '检查原数据，再给出汇总结果；保留输入文件。');
  assert.deepEqual(f.loads, ['csv-summary', 'csv-check']);
  assert.equal(result.status, 'loaded'); assert.equal(result.retrievalMode, 'model');
  assert.deepEqual(result.loadedSkillIds, f.loads);
  assert.equal(result.loaded.length, 2); assert.match(result.loaded[0].content[0].text, /Full native instructions/);
  assert.match(result.next, /继续执行/);
  assert.equal(f.requests.find(request => request.action === 'route').retrievalMode, 'model');
  const library = (await f.workspace.listLibraries())[0];
  assert.equal(library.sourcePath, join(f.home, 'skills'));
  assert.deepEqual(result.library, { id: library.id, name: library.name });
  const selected = await f.workspace.routeConversation({ query: 'another task', libraryId: library.id }, f.execution);
  assert.deepEqual(selected.library, result.library);
  const unresolved = await f.workspace.routeConversation({ query: 'task', libraryId: 'unknown' }, f.execution);
  assert.equal(unresolved.status, 'needs_library');
  assert.equal(unresolved.reason, 'unknown_library_id');
});

test('recommendation-only routing returns library picks even when native skills are unavailable', async t => {
  const f = await fixture(t);
  const args = { query: '只返回技能 ID', loadSkills: false };
  f.nativeMode('missing');
  const result = await f.workspace.routeConversation(args, f.execution);
  const [library] = await f.workspace.listLibraries();
  assert.deepEqual(result.library, { id: library.id, name: library.name });
  assert.deepEqual(result.skills.map(skill => skill.skill_id), ['csv-summary', 'csv-check']);
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(f.loads, []);
  assert.deepEqual(f.lookups, []);
  assert.equal(result.status, 'recommended');
  assert.ok(result.resumeId);
  f.mode('stale');
  f.messages.push({ id: 'retry-after-change', role: 'user', source: { kind: 'user' } });
  await assert.rejects(f.workspace.routeConversation(args, f.execution), /重新运行路由/);
});

test('same-turn routing reuses a nonempty selection and respects the user’s explicit skill cap', async t => {
  const f = await fixture(t);
  const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  f.selected(['csv-summary']);
  f.messages.push(user('capped', '请检查 CSV 的重复，最多推荐一项。'));
  const original = await f.workspace.routeConversation({ query: '检查重复', loadSkills: false, k: 10 }, f.execution);
  const duplicate = await f.workspace.routeConversation({ query: '请再检查重复', libraryId: original.library.id, k: 20 }, f.execution);
  assert.deepEqual(duplicate, { ...original, reused: true });
  assert.deepEqual(f.requests.filter(request => request.action === 'route').map(request => request.k), [1]);
  assert.deepEqual(f.loads, []);

  f.messages.push(user('fresh', '检查最多 2 列数据，并汇总。'));
  const fresh = await f.workspace.routeConversation({ query: '检查并汇总', k: 8 }, f.execution);
  assert.equal(fresh.status, 'loaded');
  assert.equal(fresh.reused, undefined);
  assert.deepEqual(f.requests.filter(request => request.action === 'route').map(request => request.k), [1, 8]);
  assert.deepEqual(f.loads, ['csv-summary']);
});

test('no suitable skill continues the task without loading, installing or inventing one', async t => {
  const f = await fixture(t); f.selected([]);
  const result = await f.workspace.routeConversation({ query: '无匹配的任务' }, f.execution);
  assert.deepEqual(result.skills, []); assert.deepEqual(result.loaded, []); assert.deepEqual(f.loads, []);
  assert.equal(result.status, 'no_match'); assert.deepEqual(f.lookups, []);
  assert.match(result.next, /继续处理原任务/);
});

test('conversation routing keeps the full selection and reports all preflight blockers before attempting loads', async t => {
  for (const [state, codes] of [
    ['shadowed', ['native_path_mismatch', 'native_path_mismatch']],
    ['mixed', ['native_missing', 'native_not_invocable']],
    ['error', ['native_check_failed', 'native_check_failed']],
    ['scope-error', ['scope_unavailable', 'scope_unavailable']],
  ]) {
    const f = await fixture(t);
    if (state === 'scope-error') f.mode(state); else f.nativeMode(state);
    const result = await f.workspace.routeConversation({ query: 'task' }, f.execution);
    assert.equal(result.status, 'blocked'); assert.equal(result.loadStage, 'preflight');
    assert.deepEqual(result.skills.map(skill => skill.skill_id), ['csv-summary', 'csv-check']);
    assert.deepEqual(result.blocked.map(skill => skill.code), codes);
    assert.deepEqual(result.loadedSkillIds, []); assert.deepEqual(f.loads, []);
    assert.ok(result.resumeId);
  }
});

test('native load failure preserves the successful instructions and the remaining unattempted picks', async t => {
  for (const [mode, status, failed, code, unattempted] of [
    ['second-load-error', 'partial', 'csv-check', 'native_load_failed', ['csv-archive']],
    ['load-error', 'blocked', 'csv-summary', 'native_load_failed', ['csv-check', 'csv-archive']],
    ['load-throw', 'blocked', 'csv-summary', 'native_load_failed', ['csv-check', 'csv-archive']],
    ['wrong-resource', 'blocked', 'csv-summary', 'native_loaded_path_mismatch', ['csv-check', 'csv-archive']],
  ]) {
    const f = await fixture(t);
    f.selected(['csv-summary', 'csv-check', 'csv-archive']); f.mode(mode);
    const result = await f.workspace.routeConversation({ query: 'task' }, f.execution);
    assert.equal(result.status, status); assert.equal(result.loadStage, 'invocation');
    assert.deepEqual(result.loadedSkillIds, status === 'partial' ? ['csv-summary'] : []);
    assert.deepEqual(result.blocked.map(skill => [skill.skillId, skill.code]), [[failed, code]]);
    assert.deepEqual(result.unattemptedSkillIds, unattempted);
    assert.equal(result.skills.length, 3);
    assert.ok(result.resumeId);
    assert.doesNotMatch(JSON.stringify(result), /Internal tool details/);
  }
});

test('conversation routing requires a caller and cancellation stops inference before any skill load', async t => {
  const f = await fixture(t);
  await assert.rejects(f.workspace.routeConversation({ query: 'task' }, { signal: f.execution.signal }), /当前 DSH 对话/);
  f.mode('cancel');
  await assert.rejects(f.workspace.routeConversation({ query: 'task' }, f.execution), { name: 'AbortError' });
  assert.deepEqual(f.loads, []);
});

test('conversation vector routing keeps the original graph and embedding prerequisites', async t => {
  const f = await fixture(t);
  const route = () => f.workspace.routeConversation({ query: 'task', retrievalMode: 'vector' }, f.execution);
  await assert.rejects(route(), /向量检索.*建图/);
  f.graph({ embedding_model: '' }); await assert.rejects(route(), /不含向量索引/);
  f.graph({ embedding_model: 'configured-embedding' }); await assert.rejects(route(), /配置/);
  assert.deepEqual(f.loads, []);
});

test('conversation library selectors normalize names, keep strict IDs, and reject ambiguity before retrieval', async t => {
  const f = await fixture(t);
  const firstPath = join(f.home, 'first', 'Résumé');
  const secondPath = join(f.home, 'second', 'Résumé');
  const otherPath = join(f.home, 'other');
  for (const path of [firstPath, secondPath, otherPath]) {
    await mkdir(join(path, 'csv-summary'), { recursive: true });
    await writeFile(join(path, 'csv-summary', 'SKILL.md'), 'Relevant task');
  }
  f.selected([]);
  const first = (await f.workspace.connect({ sourcePath: firstPath })).connection;
  const other = (await f.workspace.connect({ sourcePath: otherPath })).connection;
  const route = args => f.workspace.routeConversation({ query: 'task', loadSkills: false, ...args }, f.execution);
  assert.deepEqual((await route({ libraryName: '  RE\u0301SUME\u0301  ' })).library, { id: first.id, name: 'Résumé' });
  assert.deepEqual((await route({ libraryName: 'other', libraryId: other.id })).library, { id: other.id, name: 'other' });
  await f.workspace.connect({ sourcePath: secondPath });
  const calls = f.requests.length;
  for (const [input, reason] of [
    [{ libraryName: 'unknown' }, 'unknown_library_name'],
    [{ libraryName: 'résumé' }, 'ambiguous_library'],
    [{ libraryId: 'Résumé' }, 'unknown_library_id'],
    [{ libraryId: other.id, libraryName: 'résumé' }, 'library_conflict'],
  ]) {
    const result = await route(input);
    assert.equal(result.status, 'needs_library'); assert.equal(result.library, null);
    assert.equal(result.reason, reason); assert.equal(result.libraries.length, reason === 'ambiguous_library' ? 2 : 3);
    assert.ok(result.libraries.every(library => library.sourcePath));
  }
  assert.equal(f.requests.length, calls);
});

test('pending profiles force auto routing through current sources and refuse explicit vector before inference', async t => {
  const f = await fixture(t);
  const endpoint = 'http://127.0.0.1:1/v1';
  f.settings({ embedding_api_key: { value: true }, embedding_model: { value: 'embed' }, embedding_base_url: { value: endpoint } });
  f.graph({ embedding_model: 'embed', embedding_base_url: endpoint });
  const args = { query: 'Find the data inspection skill', loadSkills: false };
  assert.equal((await f.workspace.routeConversation(args, f.execution)).retrievalMode, 'vector');
  f.profiles(['csv-archive']); f.selected(['csv-archive']);
  f.messages.push({ id: 'retry-with-pending-profiles', role: 'user', source: { kind: 'user' } });
  const result = await f.workspace.routeConversation(args, f.execution);
  assert.equal(result.retrievalMode, 'model');
  assert.deepEqual(result.skills.map(value => value.skill_id), ['csv-archive']);
  const before = f.requests.filter(request => request.action === 'route').length;
  f.messages.push({ id: 'explicit-vector-request', role: 'user', source: { kind: 'user' } });
  await assert.rejects(f.workspace.routeConversation({ ...args, retrievalMode: 'vector' }, f.execution), /索引缺少部分技能画像/);
  assert.equal(f.requests.filter(request => request.action === 'route').length, before);
});

test('only a new user message in the same live conversation can continue the latest selected package versions', async t => {
  const f = await fixture(t);
  const route = () => f.workspace.routeConversation({ query: 'task', loadSkills: false }, f.execution);
  const prior = await route();
  f.messages.push({ id: 'latest-route', role: 'user', source: { kind: 'user' } });
  const current = await route();
  const before = f.requests.filter(request => request.action === 'route').length;
  const next = resumeId => f.workspace.continueConversationRoute({ resumeId }, f.execution);
  assert.notEqual(prior.resumeId, current.resumeId);
  await assert.rejects(next(prior.resumeId), /没有这份可继续/);
  await assert.rejects(f.workspace.continueConversationRoute({ resumeId: current.resumeId }, { ...f.execution, agent: { id: f.execution.agent.id } }), /没有这份可继续/);
  f.messages.push({ id: 'skill-generated', role: 'user', source: { kind: 'skill-invocation' } });
  await assert.rejects(next(current.resumeId), /请等用户/);
  f.messages.push({ id: 'second-request', role: 'user', source: { kind: 'user' } });
  const continued = await next(current.resumeId);
  assert.equal(continued.status, 'loaded');
  assert.deepEqual(continued.loadedSkillIds, ['csv-summary', 'csv-check']);
  assert.deepEqual(JSON.parse(JSON.stringify(continued)), continued);
  assert.equal(continued.resumeId, undefined);
  assert.equal(f.requests.filter(request => request.action === 'route').length, before);
  await assert.rejects(next(current.resumeId), /没有这份可继续/);

  const saved = await route();
  await writeFile(join(f.home, 'skills', 'csv-summary', 'reference.txt'), 'New supporting instructions');
  f.messages.push({ id: 'third-request', role: 'user', source: { kind: 'user' } });
  await assert.rejects(next(saved.resumeId), /技能包已变化/);
  assert.equal(f.loads.length, 2);
  await assert.rejects(next(saved.resumeId), /没有这份可继续/);
});

test('the registered tool renders a partial routing result before only the instructions that actually loaded', async t => {
  const f = await fixture(t);
  f.mode('second-load-error'); f.selected(['csv-summary', 'csv-check', 'csv-archive']);
  const registered = new Map();
  apply({ effect() {}, tools: { register: value => registered.set(value.name, value) },
    systemPrompt: { section() {} }, skills: { register() {} } }, { dshHome: f.home });
  const tool = registered.get('skillnet_route'), resume = registered.get('skillnet_route_continue');
  assert.equal(tool.parameters.properties.libraryName.type, 'string');
  assert.deepEqual(resume.parameters.required, ['resumeId']);
  const result = await f.workspace.routeConversation({ query: 'task' }, f.execution);
  const blocks = tool.output.render({}, result);
  const metadata = JSON.parse(blocks[0].text);
  assert.equal(metadata.status, 'partial');
  assert.deepEqual(metadata.loadedSkillIds, ['csv-summary']);
  assert.deepEqual(metadata.unattemptedSkillIds, ['csv-archive']);
  assert.equal(metadata.blocked[0].skillId, 'csv-check');
  assert.equal(metadata.loaded[0].effectivePath, join(f.home, 'skills', 'csv-summary', 'SKILL.md'));
  assert.equal(metadata.loaded[0].content, undefined);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1].text, /Full native instructions/);
});


test('automatic library selection uses connected scope and preserves explicit or ambiguous intent', async t => {
  const f = await fixture(t);
  const reports = await f.connect('报表分析', ['explore-data']);
  const publishing = await f.connect('报表发布', ['publish-report']);
  let chosen = reports.id;
  let calls = 0;
  f.selectLibraries(async ({ root }) => {
    calls++;
    const index = await readFile(join(root, 'index.md'), 'utf8');
    assert.match(index, /报表分析/);
    assert.match(index, /报表发布/);
    return { content: JSON.stringify({ libraryId: chosen, reason: '目录对照。' }) };
  });
  const route = args => f.workspace.routeConversation({ query: '检查报表中的空值', loadSkills: false, ...args }, f.execution);
  f.selected(['explore-data']);
  const matched = await route({});
  assert.equal(matched.library.id, reports.id);
  assert.equal(matched.libraryReason, '目录对照。');
  assert.deepEqual(matched.skills.map(skill => skill.skill_id), ['explore-data']);
  f.selected(['publish-report']);
  const explicit = await route({ libraryScope: 'auto', libraryId: publishing.id });
  assert.equal(explicit.library.id, publishing.id);
  assert.equal(calls, 1);
  const reused = await route({ libraryScope: 'auto' });
  assert.deepEqual(reused, { ...matched, reused: true });
  assert.equal(calls, 1);
  f.messages.push({ id: 'ambiguous-new-request', role: 'user', source: { kind: 'user' } });
  chosen = null;
  const before = f.requests.filter(request => request.action === 'route').length;
  const unclear = await route({ libraryScope: 'auto' });
  assert.equal(unclear.status, 'needs_library');
  assert.equal(unclear.reason, 'uncertain_library');
  assert.equal(f.requests.filter(request => request.action === 'route').length, before);
  const guessed = await route({ libraryId: reports.id });
  assert.deepEqual(guessed, { ...unclear, reused: true });
  assert.equal(f.requests.filter(request => request.action === 'route').length, before);
});

test('cross-library routing carries source identities through preflight and same-chat continuation', async t => {
  const f = await fixture(t);
  const reports = await f.connect('报表分析', ['explore-data']);
  const figures = await f.connect('学术绘图', ['figure-export']);
  await f.connect('报表发布', ['publish-report']);
  let explored = 0;
  f.selectLibraries(async ({ root }) => {
    explored++;
    const index = await readFile(join(root, 'index.md'), 'utf8');
    assert.doesNotMatch(index, /报表发布/);
    assert.match(await readFile(join(root, 'sources', 's2.md'), 'utf8'), /figure-export/);
    return { content: '{"skills":[{"id":"s1","reason":"分析"},{"id":"s2","reason":"画图"}]}' };
  });
  f.nativeMode('missing');
  const result = await f.workspace.routeConversation({
    query: '先检查缺失，再画论文图', libraryScope: 'combine', libraryNames: ['报表分析', '学术绘图'],
  }, f.execution);
  assert.equal(result.status, 'blocked');
  assert.equal(result.library, null);
  assert.equal(result.retrievalMode, 'model');
  assert.deepEqual(result.skills.map(skill => skill.library.id), [reports.id, figures.id]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(result.blocked.map(skill => skill.library.id), [reports.id, figures.id]);
  assert.deepEqual(f.loads, []);
  const reused = await f.workspace.routeConversation({
    query: '检查再绘图', libraryScope: 'combine', libraryNames: ['学术绘图', '报表分析'],
  }, f.execution);
  assert.deepEqual(reused, { ...result, reused: true });
  f.nativeMode('ok');
  f.messages.push({ id: 'resume-cross', role: 'user', source: { kind: 'user' } });
  const continued = await f.workspace.continueConversationRoute({ resumeId: result.resumeId }, f.execution);
  assert.equal(continued.status, 'loaded');
  assert.deepEqual(continued.loaded.map(skill => skill.library.id), [reports.id, figures.id]);
  assert.deepEqual(f.loads, ['explore-data', 'figure-export']);
  assert.equal(explored, 1);
});
