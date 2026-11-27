import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTaskStore } from './task-store.js';
import { createAnalysisConversation } from './analysis-conversation.js';
import { createAnalysisPacer } from './analysis-pacing.js';
import { managedLibraryInfo } from './library.js';
import { exploreLibraries } from './federated-route.js';

const secrets = ['api_key', 'embedding_api_key', 'explorer_api_key', 'github_token'];
const fields = ['base_url', 'model', 'embedding_base_url', 'embedding_model', 'explorer_base_url', 'explorer_model', 'json_mode', 'skillnet_api_url', 'github_mirror'];
const settingNames = { api_key: '分析模型 API 密钥', embedding_api_key: '向量模型 API 密钥', embedding_base_url: '向量模型地址', embedding_model: '向量模型名称', explorer_api_key: 'DSH 探索器 API 密钥', explorer_base_url: 'DeepSeek Messages 地址', explorer_model: '探索器模型名称' };
const actionNames = { analyze: '建图', route: '任务路由', create: '创建技能', evaluate: '评估技能', 'evaluate-batch': '批量评估' };
const personalLibraryName = 'DSH 个人技能库';
export const reviewSampleFile = new URL('../.local/relation-review-sample.json', import.meta.url);
const credential = key => `DSH_SKILLNET_${key.toUpperCase()}`;
const same = (a, b) => Boolean(a && b) && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const libraryNameKey = name => name.trim().normalize('NFC').toLowerCase();
const librarySummary = ({ id, name }) => ({ id, name });
const vectorRouteIssue = data => {
  if (!data?.graph || data.analysisError) return '请先启用向量检索并成功建图，再运行向量路由。';
  if (data.graph.embedding_model === '') return '当前图谱不含向量索引，请启用向量检索后重新建图。';
  if (data.pendingProfiles?.length) return '向量索引缺少部分技能画像，请在面板更新图谱后重新路由。';
  if (data.changedSkills || data.addedSkills || data.removedSkills) return '技能文件有变化，请先重新建图。';
  return null;
};
const loadingMessages = {
  scope_unavailable: '无法核验当前对话的技能作用域。',
  native_missing: '当前对话中找不到此技能的原生定义。',
  native_not_invocable: '当前对话的原生定义不允许这种调用。',
  native_path_mismatch: '当前对话命中的原生定义指向其他路径。',
  installed_copy_unverified: '个人库同名技能未绑定到此次所选的来源。',
  installed_copy_stale: '已安装副本与所选来源包版本不一致。',
  native_check_failed: '未能核验当前对话的原生定义。',
  native_load_failed: '原生技能工具未成功返回完整指令。',
  native_loaded_path_mismatch: '原生工具返回的资源目录与核验通过的包不一致。',
};
const text = (value, name, limit = 100_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${name}不能为空或超过长度限制。`);
  return value.trim();
};

const requestedRouteCap = [
  /(?:最多|至多|不超过)\s*(\d+|[一二两三四五六七八九十]{1,3})\s*(?:个|项|条)?\s*技能/giu,
  /(?:(?:最多|至多|不超过)\s*(?:推荐|返回|选出?|列出)|(?:推荐|返回|选出?|列出)\s*(?:最多|至多|不超过))\s*(\d+|[一二两三四五六七八九十]{1,3})\s*(?:个|项|条)(?=\s*(?:技能|[，。；、,.!?！？;]|$))/giu,
  /\b(?:at most|up to|no more than)\s+(\d+)\s+skills?\b/giu,
];
function routeLimit(k, message) {
  const userText = (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').normalize('NFKC');
  let limit = Math.max(1, Math.min(20, Math.trunc(Number(k)) || 5));
  for (const pattern of requestedRouteCap) {
    for (const [, raw] of userText.matchAll(pattern)) {
      const digits = '零一二三四五六七八九';
      const chinese = raw.replaceAll('两', '二');
      const [tens, ones] = chinese.split('十');
      const cap = /^\d+$/.test(raw) ? Number(raw) : ones === undefined ? digits.indexOf(tens)
        : (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
      if (cap >= 1) limit = Math.min(limit, cap);
    }
  }
  return limit;
}

export function createWorkspace(ctx, run, library, hostModel) {
  const root = join(library.home, 'skillnet');
  const taskStore = createTaskStore(root);
  let mutation = Promise.resolve();
  const locks = new Set();
  const evaluationBatches = new Set();
  const recentRoutes = new WeakMap();
  const turnRoutes = new WeakMap();
  const activeRoutes = new WeakSet();
  const serial = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const read = async (name, fallback) => {
    try { return JSON.parse(await readFile(join(root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  const save = async (name, value) => {
    const path = join(root, name);
    await mkdir(resolve(path, '..'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
  };
  async function configured(request, signal, invokeHost, onProgress) {
    if (request.action === 'local-library' || request.action === 'check') return run(request, signal);
    if (request.action === 'discover') {
      const { skillnet_api_url } = await read('settings.json', {});
      return run({ ...request, _settings: { skillnet_api_url } }, signal);
    }
    if (request.action === 'source-status') {
      const found = await ctx.credentials.resolve(credential('github_token'));
      return run({ ...request, _settings: found ? { github_token: found.value } : {} }, signal);
    }
    const settings = { ...await read('settings.json', {}), explorer_backend: 'dsh' };
    for (const key of secrets) {
      const found = await ctx.credentials.resolve(credential(key));
      if (found) settings[key] = found.value;
    }
    if (request._host_model || request.action === 'analysis-step' || (request.action === 'analysis-plan' && request.modelSelection)) { delete settings.api_key; delete settings.explorer_api_key; }
    const { evaluationSdkModel, ...payload } = request;
    if (evaluationSdkModel) {
      const expected = evaluationSdkModel;
      if (settings.model !== expected.model || settings.base_url !== expected.baseUrl) {
        const { fields } = await run({ action: 'settings', _settings: settings }, signal);
        if (fields.model?.value !== expected.model || fields.base_url?.value !== expected.baseUrl) {
          throw new Error('独立评估模型配置已改变，请恢复本批次所用的模型配置后再继续。');
        }
      }
    }
    return run({ ...payload, _settings: settings }, signal, invokeHost, onProgress);
  }
  async function settings(args = {}, signal) {
    const changes = args.values ?? {};
    if (args.values || args.clearSecrets?.length) await serial(async () => {
      const values = await read('settings.json', {});
      for (const [key, value] of Object.entries(changes)) {
        if (![...fields, ...secrets].includes(key) || typeof value !== 'string') throw new Error('未知的配置字段。');
        if (value.length > 4096) throw new Error('配置值过长。');
        if (fields.includes(key)) {
          if ((key.endsWith('base_url') || key.endsWith('api_url') || key === 'github_mirror') && value) {
            const url = URL.parse(value.trim());
            if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含凭据和查询参数的 HTTP(S) 地址。');
          }
          if (key === 'json_mode' && !['auto', 'on', 'off', ''].includes(value)) throw new Error('JSON 模式无效。');
          if (value.trim()) values[key] = value.trim(); else delete values[key];
        }
      }
      // Validate the complete non-secret settings before committing credentials.
      for (const key of secrets) if (changes[key]?.trim()) await ctx.credentials.set(credential(key), changes[key].trim());
      for (const key of args.clearSecrets || []) if (secrets.includes(key)) await ctx.credentials.unset(credential(key));
      await save('settings.json', values);
    });
    return configured({ action: 'settings' }, signal);
  }
  const workspaceState = () => read('workspace.json', { libraries: [] });
  async function connectPath(state, args, signal, select) {
    if (!isAbsolute(args.sourcePath || '')) throw new Error('请填写技能库的绝对路径。');
    const sourcePath = await realpath(args.sourcePath);
    const previous = state.libraries.find(item => same(item.sourcePath, sourcePath));
    const explicit = Object.hasOwn(args, 'indexPath');
    const defaultIndex = join(sourcePath, '.skillnet');
    // The default is an analysis output location, not an existing input folder.
    // Older clients also send this saved path back when reopening a fresh library.
    const customIndex = explicit && args.indexPath && !same(args.indexPath, defaultIndex);
    const indexPath = explicit ? (customIndex ? await realpath(args.indexPath) : defaultIndex) : previous?.indexPath || defaultIndex;
    const data = await configured({ action: 'local-library', sourcePath, indexPath: same(indexPath, defaultIndex) ? undefined : indexPath }, signal);
    if (customIndex && (!data.graph || data.analysisError)) throw new Error(data.analysisError || '这个目录中没有可用的分析结果。');
    let analysisRevision = null;
    if (data.graph && !data.analysisError) {
      try { analysisRevision = `${indexPath}/${(await readFile(join(indexPath, 'CURRENT'), 'utf8')).trim()}`; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Imported flat indexes have no CURRENT pointer.
        try { analysisRevision = `${indexPath}/graph.json:${(await stat(join(indexPath, 'graph.json'))).mtimeMs}`; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const managed = await managedLibraryInfo(library.home, sourcePath);
    const name = managed?.name || (same(sourcePath, join(library.home, 'skills')) ? personalLibraryName : basename(sourcePath));
    const item = { id: managed?.id || previous?.id || randomUUID(), name, sourcePath, indexPath, ...(managed && { managed: true }) };
    state.libraries = [...state.libraries.filter(x => x.id !== item.id && x.id !== previous?.id), item];
    if (select) state.lastPath = sourcePath;
    await save('workspace.json', state);
    return { ...data, analysisRevision, connection: item };
  }
  function connect(args, signal) {
    return serial(async () => connectPath(await workspaceState(), args, signal, true));
  }
  async function listLibraries() { return (await workspaceState()).libraries; }
  function createNamed(args, signal) {
    return serial(async () => {
      const name = text(args.name, '技能库名称', 60).normalize('NFC');
      const state = await workspaceState();
      if ([personalLibraryName, ...state.libraries.map(item => item.name)].some(existing => existing.normalize('NFC').toLowerCase() === name.toLowerCase())) {
        throw new Error('已有同名技能库，请换一个名称。');
      }
      signal?.throwIfAborted();
      const sourcePath = await library.createManaged(name);
      return connectPath(state, { sourcePath }, undefined, true);
    });
  }
  async function installTargets() {
    const state = await workspaceState();
    const managed = state.libraries.filter(item => item.managed);
    return {
      targets: [{ id: '', name: personalLibraryName, sourcePath: join(library.home, 'skills') }, ...managed],
      currentId: managed.find(item => same(item.sourcePath, state.lastPath))?.id || '',
    };
  }
  function install(args, signal) {
    return serial(async () => {
      if (args.scope && args.scope !== 'user') throw new Error('请选择个人技能库或独立技能库。');
      const target = args.libraryId ? await selected({ libraryId: args.libraryId }) : null;
      if (target && !target.managed) throw new Error('请选择在 SkillNet 新建的技能库。');
      const result = await library.install({
        previewId: args.previewId,
        scope: target ? 'managed' : 'user',
        managedId: target?.id,
        sourcePath: target?.sourcePath,
      }, signal);
      try {
        const data = await connectPath(await workspaceState(), { sourcePath: dirname(result.path) }, undefined, false);
        result.connection = data.connection;
      } catch (error) { result.connectionWarning = error.message; }
      return { ...result, libraryName: target?.name || personalLibraryName };
    });
  }
  async function forget(args) {
    return serial(async () => {
      const state = await read('workspace.json', { libraries: [] });
      const removed = state.libraries.filter(item => item.id === args.libraryId || same(item.sourcePath, args.sourcePath || ''));
      state.libraries = state.libraries.filter(item => !removed.includes(item));
      if (removed.some(item => same(item.sourcePath, state.lastPath))) state.lastPath = null;
      await save('workspace.json', state);
      return { removed: true };
    });
  }
  async function selected(args) {
    const items = await listLibraries();
    let requested = args.sourcePath;
    if (!args.libraryId && typeof requested === 'string') {
      try { requested = await realpath(requested); } catch { throw new Error('请先在 SkillNet 面板连接这个技能库。'); }
    }
    const item = items.find(x => args.libraryId ? x.id === args.libraryId : typeof requested === 'string' && same(x.sourcePath, requested));
    if (!item) throw new Error('请先在 SkillNet 面板连接这个技能库。');
    if (!same(await realpath(item.sourcePath), item.sourcePath)) throw new Error('技能库路径已改变，请重新连接。');
    return item;
  }
  async function conversationLibrary(args, signal) {
    const id = args.libraryId === undefined ? undefined : text(args.libraryId, '技能库 ID');
    const name = args.libraryName === undefined ? undefined : libraryNameKey(text(args.libraryName, '技能库名称'));
    if (!id && !name) {
      return serial(async () => {
        const state = await workspaceState();
        if (state.libraries.length === 1) return { item: state.libraries[0] };
        if (state.libraries.length) return { libraries: state.libraries, reason: 'library_required' };
        return { item: (await connectPath(state, await createDefault(), signal, false)).connection };
      });
    }
    const libraries = await listLibraries();
    if (id) {
      const item = libraries.find(value => value.id === id);
      if (!item) return { libraries, reason: 'unknown_library_id' };
      if (name && libraryNameKey(item.name) !== name) return { libraries, reason: 'library_conflict' };
      return { item };
    }
    const matches = libraries.filter(item => libraryNameKey(item.name) === name);
    if (matches.length === 1) return { item: matches[0] };
    return matches.length ? { libraries: matches, reason: 'ambiguous_library' } : { libraries, reason: 'unknown_library_name' };
  }
  async function taskStatus(task) {
    // Finished records outlive DSH's in-memory registry. Reading their saved
    // results must not depend on a job still being retained by the host.
    if (!['running', 'stopping'].includes(task.status)) return { ...task, progress: null };
    let live;
    try { live = ctx.jobs.get(task.id, task.owner); }
    catch (error) { if (error.message !== `unknown job ${task.id}`) throw error; }
    if (!live) {
      Object.assign(task, { status: 'failed', error: 'DSH 已重启或作业已退出，这个任务已中断。请重新运行。', finishedAt: new Date().toISOString() });
      await taskStore.write(task);
    }
    return { ...task, progress: live?.progress || null };
  }
  async function getTask(id, owner) { return taskStatus(await taskStore.get(id, owner)); }
  async function tasks(args = {}, owner) {
    const page = await taskStore.list(args, owner);
    for (let index = 0; index < page.items.length; index++) page.items[index] = await taskStatus(page.items[index]);
    return page;
  }
  async function latestEvaluation(args, signal) {
    const item = await selected(args);
    const skillId = text(args.skillId, '技能标识');
    const history = (await taskStore.evaluationsBySkill(item.sourcePath)).get(skillId);
    if (!history?.length) return null;
    let currentVersion;
    if (history.some(task => task.sourceVersion)) {
      const data = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
      const skill = data.source.skills.find(value => value.id === skillId);
      if (skill) currentVersion = await library.sourcePackageVersion(await skillSourcePath(item, skill), signal);
    }
    const current = currentVersion && history.find(task => task.sourceVersion === currentVersion);
    const task = current || history[0];
    return { ...await getTask(task.id), versionStatus: current ? 'current' : task.sourceVersion ? 'historical' : 'unversioned' };
  }
  async function captureRouteModel(execution, sessionId) {
    const host = await hostModel.capture(execution, sessionId);
    return (await hostModel.forRoute?.(host, execution.signal)) ?? host;
  }
  async function prepare(args, execution, capturedHost) {
    const action = args.action;
    if (!['analyze', 'route', 'create', 'evaluate'].includes(action)) throw new Error('未知的作业类型。');
    const item = action === 'create' ? null : await selected(args);
    const request = { action };
    let prior;
    if (action === 'analyze' && args.retryTaskId) {
      prior = await taskStore.get(args.retryTaskId, execution.agent?.id);
      if (prior.action !== action || prior.libraryId !== item.id || !prior.result?.pending_relations) {
        throw new Error('这个建图任务没有可重试的候选。');
      }
      request.retrySnapshot = prior.result.snapshot;
      if (!request.retrySnapshot) {
        // Older results have no snapshot ID. Only bind the latest published task.
        const latest = await taskStore.list({ action, sourcePath: item.sourcePath, status: 'completed', limit: 1 });
        if (latest.items[0]?.id !== prior.id) throw new Error('图谱已有更新，请查看最新建图结果。');
        request.retrySnapshot = (await readFile(join(item.indexPath, 'CURRENT'), 'utf8')).trim();
      }
    }
    if (['analyze', 'route'].includes(action)) {
      request.retrievalMode = prior?.retrievalMode ?? args.retrievalMode ?? 'model';
      if (!['auto', 'model', 'vector'].includes(request.retrievalMode)) throw new Error('请选择自动、仅使用模型或向量检索模式。');
    }
    let host = capturedHost;
    if (prior) {
      if (prior.model) {
        const selection = { ...prior.model };
        if (prior.relationReasoningEffort === 'default') delete selection.reasoningEffort;
        else if (prior.relationReasoningEffort) selection.reasoningEffort = prior.relationReasoningEffort;
        host = { selection, sessionId: prior.sessionId };
      }
    } else if (action !== 'route' && hostModel && args.modelSource !== 'sdk') {
      host = await hostModel.capture(execution, args.sessionId);
    }
    if (item) Object.assign(request, { sourcePath: item.sourcePath, indexPath: item.indexPath });
    let routeData, preflight;
    if (action === 'route') {
      request.query = text(args.query, '任务');
      request.k = routeLimit(args.k);
      const routeHost = host ?? (hostModel && args.modelSource !== 'sdk' ? captureRouteModel(execution, args.sessionId) : undefined);
      [routeData, preflight, host] = await Promise.all([
        configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, execution.signal),
        settings({}, execution.signal),
        routeHost,
      ]);
      if (!routeData.source.skills.length) throw new Error('技能库中还没有可用技能。');
      if (request.retrievalMode === 'vector') {
        const issue = vectorRouteIssue(routeData);
        if (issue) throw new Error(issue);
      }
      request.backend = 'dsh';
    }
    if (action === 'create') {
      if (!['prompt', 'trajectory', 'github', 'conversation'].includes(args.input_type || 'prompt')) throw new Error('请选择需求、轨迹、当前对话或 GitHub 来源。');
      request.input_type = args.input_type === 'conversation' ? 'trajectory' : args.input_type || 'prompt';
      const field = { prompt: 'prompt', trajectory: 'trajectory_content', github: 'github_url' }[request.input_type];
      const content = args.input_type === 'conversation' && !args.content?.trim() ? (await hostModel.conversation(host?.sessionId || args.sessionId || execution.agent?.id, execution.signal)).content : args.content;
      request[field] = text(content, '内容');
      if (field === 'github_url' && !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(request[field])) throw new Error('请填写 GitHub 仓库地址。');
    }
    if (action === 'evaluate') {
      const data = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, execution.signal);
      const skill = data.source.skills.find(s => s.id === args.skillId);
      if (!skill) throw new Error('这个技能不在当前库中。');
      request.path = dirname(await skillSourcePath(item, skill));
    }
    // Preflight endpoints before allocating a job. SDK validates each endpoint independently.
    if (host) request._host_model = host.selection;
    const current = preflight ?? await settings({}, execution.signal);
    const vectors = ['embedding_api_key', 'embedding_base_url', 'embedding_model'];
    if (request.retrievalMode === 'auto') {
      const configuredVectors = vectors.every(key => current.fields[key]?.value);
      const endpoint = value => String(value || '').replace(/\/+$/, '');
      const routeIndex = routeData?.graph?.embedding_model &&
        routeData.graph.embedding_model === current.fields.embedding_model?.value &&
        endpoint(routeData.graph.embedding_base_url) === endpoint(current.fields.embedding_base_url?.value) &&
        !vectorRouteIssue(routeData);
      request.retrievalMode = configuredVectors && (action === 'analyze' || routeIndex) ? 'vector' : 'model';
    }
    const required = [
      ...(!host ? action === 'route' ? ['explorer_api_key', 'explorer_base_url', 'explorer_model'] : ['api_key'] : []),
      ...(request.retrievalMode === 'vector' && !prior ? vectors : []),
    ];
    const missing = required.filter(key => !current.fields[key]?.value);
    if (missing.length) throw new Error(`请先在设置中配置：${missing.map(key => settingNames[key] || key).join('、')}`);
    return { action, item, request, host };
  }
  async function evaluatePackage(request, record, signal, invoke, sourceVersion) {
    const expected = join(request.path, 'SKILL.md');
    record.sourceVersion = sourceVersion ?? await library.sourcePackageVersion(expected, signal);
    const result = await configured(request, signal, invoke);
    signal.throwIfAborted();
    if (await library.sourcePackageVersion(expected, signal) !== record.sourceVersion) {
      throw new Error('评估期间技能包已改变，请重新评估。');
    }
    return result;
  }
  async function startEvaluationBatch(args, execution) {
    const { signal, agent } = execution;
    const item = await selected({ libraryId: text(args.libraryId, '技能库 ID') });
    const mode = args.batchMode ?? 'missing';
    if (!['missing', 'all'].includes(mode)) throw new Error('请选择未评估的技能或全部技能。');
    const prior = args.retryTaskId ? await taskStore.get(args.retryTaskId, agent?.id) : null;
    if (prior && (prior.action !== 'evaluate-batch' || prior.libraryId !== item.id || !same(prior.sourcePath, item.sourcePath) || ['running', 'stopping'].includes(prior.status))) {
      throw new Error('请选择本库已结束的批量评估作业。');
    }
    const previousFailures = prior?.result?.items?.filter(value => value.status === 'failed').map(value => value.skillId);
    if (prior && !previousFailures?.length) throw new Error('这批评估没有可重试的失败项。');

    const sessionId = args.sessionId === undefined ? undefined : text(args.sessionId, 'DSH 对话');
    const modelSource = prior?.modelSource ?? args.modelSource ?? (sessionId ? 'host' : null);
    if (!['host', 'sdk'].includes(modelSource) || !prior && modelSource === 'sdk' && sessionId) {
      throw new Error('请明确选择用于批量评估的 DSH 对话、默认 DSH 模型或独立模型。');
    }
    let host, model;
    if (modelSource === 'host') {
      host = prior ? { selection: prior.model, sessionId: prior.sessionId } : await hostModel.capture(execution, sessionId);
      model = host.selection;
      if (!model?.provider || !model.model) throw new Error('无法确认该批次使用的 DSH 模型。');
    } else {
      const { fields } = await settings({}, signal);
      if (!fields.api_key?.value || !fields.base_url?.value || !fields.model?.value) throw new Error('请先在设置中配置独立评估模型。');
      model = { provider: 'sdk', baseUrl: fields.base_url.value, model: fields.model.value };
      if (prior && (prior.model?.model !== model.model || prior.model?.baseUrl !== model.baseUrl)) {
        throw new Error('独立评估模型配置已改变，请恢复本批次所用的模型配置后再继续。');
      }
    }
    const data = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
    const source = new Map(data.source.skills.map(skill => [skill.id, skill]));
    const queue = previousFailures ?? [...source.keys()];
    if (!queue.length) throw new Error('这个技能库还没有可评估的技能。');
    const lock = process.platform === 'win32' ? item.sourcePath.toLowerCase() : item.sourcePath;
    signal?.throwIfAborted();
    if (evaluationBatches.has(lock)) throw new Error('这个技能库已有批量评估作业在运行。');
    evaluationBatches.add(lock);
    const initialized = Promise.withResolvers();
    let id;
    try {
      id = ctx.jobs.start({ kind: 'skillnet-evaluate-batch', label: `SkillNet ${actionNames['evaluate-batch']} / ${item.name}`, owner: agent?.id, outputLimitBytes: 24 * 1024,
        run(job) {
          const controller = new AbortController();
          const items = queue.map(skillId => ({ skillId, status: 'unattempted' }));
          const result = { total: items.length, completed: 0, failed: 0, skipped: 0, unattempted: items.length, items };
          const context = { owner: agent?.id, libraryId: item.id, sourcePath: item.sourcePath, modelSource, model, sessionId: host?.sessionId };
          const record = { ...context, id: job.id, action: 'evaluate-batch', retryTaskId: prior?.id,
            status: 'running', startedAt: new Date().toISOString(), result };
          job.updateProgress(`已处理 0 / ${result.total}`);
          const done = (async () => {
            let jobError;
            try {
              await taskStore.write(record);
              initialized.resolve();
              const history = (prior || mode === 'missing') ? await taskStore.evaluationsBySkill(item.sourcePath) : null;
              for (const row of items) {
                controller.signal.throwIfAborted();
                job.updateProgress(`已处理 ${result.total - result.unattempted} / ${result.total} · 正在评估 ${row.skillId}`);
                const child = { ...context, id: `skillnet-evaluate-${randomUUID().replaceAll('-', '')}`,
                  action: 'evaluate', skillId: row.skillId, batchId: record.id, startedAt: new Date().toISOString(), modelSessions: [] };
                let outcome;
                try {
                  const skill = source.get(row.skillId);
                  if (!skill) throw new Error('这个技能已不在当前库中。');
                  const expected = await skillSourcePath(item, skill);
                  const sourceVersion = await library.sourcePackageVersion(expected, controller.signal);
                  const alreadyEvaluated = history?.get(row.skillId)?.some(task => task.sourceVersion === sourceVersion &&
                    (!prior || task.finishedAt > prior.finishedAt));
                  if (alreadyEvaluated) outcome = 'skipped';
                  else {
                    const cacheDir = join(root, 'artifacts', child.id, 'evaluation');
                    await mkdir(dirname(cacheDir), { recursive: true });
                    const request = { action: 'evaluate', path: dirname(expected), sourcePath: item.sourcePath, indexPath: item.indexPath,
                      cache_dir: cacheDir, ...(host ? { _host_model: host.selection } : { evaluationSdkModel: model }) };
                    const invoke = host ? (payload, modelSignal) => hostModel.invoke(host, payload, modelSignal, async id => { child.modelSessions.push(id); }) : undefined;
                    child.result = await evaluatePackage(request, child, controller.signal, invoke, sourceVersion);
                    outcome = 'completed';
                  }
                } catch (error) {
                  controller.signal.throwIfAborted();
                  outcome = 'failed';
                  child.error = error.message;
                }
                if (outcome !== 'skipped') {
                  child.status = outcome;
                  child.finishedAt = new Date().toISOString();
                  await taskStore.write(child);
                  row.taskId = child.id;
                }
                row.status = outcome;
                if (child.error) row.error = child.error;
                result[outcome]++;
                result.unattempted--;
                await taskStore.write(record);
                job.updateProgress(`已处理 ${result.total - result.unattempted} / ${result.total}`);
              }
              record.status = 'completed';
            } catch (error) {
              jobError = error;
              record.status = controller.signal.aborted ? 'killed' : 'failed';
              record.error = controller.signal.aborted ? '作业已取消。' : error.message;
            } finally {
              record.finishedAt = new Date().toISOString();
              try { await taskStore.write(record); }
              finally {
                evaluationBatches.delete(lock);
                if (jobError) initialized.reject(jobError);
              }
            }
            const { items: _details, ...summary } = result;
            return { status: record.status, detail: record.error, result: JSON.stringify({ ...record, result: summary }) };
          })();
          return { done, cancel: () => controller.abort() };
        },
      });
    } catch (error) { evaluationBatches.delete(lock); throw error; }
    await initialized.promise;
    return { id, action: 'evaluate-batch', status: 'running' };
  }
  async function start(args, execution = {}) {
    if (args.action === 'evaluate-batch') return startEvaluationBatch(args, execution);
    const { action, item, request, host } = await prepare(args, execution);
    const lock = action === 'analyze' ? (process.platform === 'win32' ? item.indexPath.toLowerCase() : item.indexPath) : null;
    if (lock && locks.has(lock)) throw new Error('这个技能库正在建图。');
    if (lock) locks.add(lock);
    try {
      let relationHost = lock ? host : null;
      if (relationHost && !request.retrySnapshot) {
        relationHost = (await hostModel.forRelationReview?.(host, execution.signal)) ?? host;
      }
      if (relationHost) {
        request._host_model = relationHost.selection;
        request.max_workers = 4;
      }
      if (lock && (request.retrySnapshot || host || args.modelSource === 'sdk')) {
        const legacy = await analysisConversation.status({ libraryId: item.id });
        if (legacy?.status === 'running') throw new Error('这个技能库正在建图。');
        if (!request.retrySnapshot) {
          const plan = await configured({ action: 'analysis-plan', sourcePath: item.sourcePath, indexPath: item.indexPath,
            retrievalMode: request.retrievalMode, modelSelection: relationHost?.selection }, execution.signal);
          execution.signal?.throwIfAborted();
          if (plan.upToDate) {
            locks.delete(lock);
            return { upToDate: true, message: '图谱已是最新。', plan };
          }
        }
      }
      execution.signal?.throwIfAborted();
      const initialized = Promise.withResolvers();
      const id = ctx.jobs.start({ kind: `skillnet-${action}`, label: `SkillNet ${actionNames[action]}${item ? ` / ${item.name}` : ''}`, owner: execution.agent?.id, outputLimitBytes: 24 * 1024,
        run(job) {
          const controller = new AbortController();
          const record = { id: job.id, action, skillId: action === 'evaluate' ? args.skillId : undefined, retrievalMode: request.retrievalMode, query: request.query, owner: execution.agent?.id, libraryId: item?.id, sourcePath: item?.sourcePath, model: host?.selection, sessionId: host?.sessionId, modelSessions: [], status: 'running', startedAt: new Date().toISOString() };
          if (relationHost) {
            record.profileReasoningEffort = relationHost.selection.reasoningEffort ?? 'default';
            record.relationReasoningEffort = record.profileReasoningEffort;
          }
          job.updateProgress(request.retrySnapshot ? '正在复核待判候选' : `正在${actionNames[action]}`);
          const done = (async () => {
            try {
              await taskStore.write(record);
              initialized.resolve();
              const artifacts = join(root, 'artifacts', job.id);
              await mkdir(artifacts, { recursive: true });
              if (action === 'create') request.output_dir = join(artifacts, 'drafts');
              if (action === 'evaluate') request.cache_dir = join(artifacts, 'evaluation');
              const invoke = host ? (payload, signal) => hostModel.invoke(relationHost ?? host, payload, signal, async id => {
                record.modelSessions.push(id);
                if (payload.label) job.updateProgress(`正在${payload.label}`);
                if (action !== 'analyze') await taskStore.write(record);
              }) : undefined;
              const runModel = invoke && action === 'analyze' ? createAnalysisPacer(invoke, message => job.updateProgress(message)) : invoke;
              record.result = action === 'evaluate'
                ? await evaluatePackage(request, record, controller.signal, runModel)
                : await configured(request, controller.signal, runModel, action === 'analyze' ? message => job.updateProgress(message) : undefined);
              record.status = 'completed';
            } catch (error) {
              initialized.reject(error);
              record.status = controller.signal.aborted ? 'killed' : 'failed';
              record.error = controller.signal.aborted ? '作业已取消。' : error.name === 'TimeoutError' && error.message === 'The operation was aborted due to timeout' ? `${actionNames[action]}执行超时，已完成的缓存与已有图谱保留。` : error.message;
            } finally {
              if (lock) locks.delete(lock);
              record.finishedAt = new Date().toISOString();
              await taskStore.write(record);
            }
            // Source versions are for handoff validation, not model output.
            // Keep large libraries from filling the native job output budget.
            let result = record.result;
            if (result?.source_versions) { const { source_versions, ...visible } = result; result = visible; }
            if (result?.drafts) result = { ...result, drafts: result.drafts.map(({ name, path, validation }) => ({ name, path, validation })) };
            const visibleRecord = { ...record, result };
            if (action === 'analyze') delete visibleRecord.modelSessions;
            return { status: record.status, detail: record.error, result: JSON.stringify(visibleRecord) };
          })();
          return { done, cancel: () => controller.abort() };
        },
      });
      await initialized.promise;
      return { id, action, status: 'running' };
    } catch (error) { if (lock) locks.delete(lock); throw error; }
  }
  async function publish(args, signal) {
    const task = await getTask(args.id);
    if (task.action !== 'create' || task.status !== 'completed') throw new Error('请选择已完成的创建作业。');
    const draft = task.result.drafts.find(d => d.name === args.name);
    if (!draft) throw new Error('草稿不存在。');
    return library.prepareLocal(draft.path, signal);
  }
  async function reviewSample(execution) {
    let sample;
    try {
      sample = JSON.parse(await readFile(reviewSampleFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('还没有准备好的固定复核小样本。');
      throw error;
    }
    const item = await selected({ libraryId: sample.libraryId });
    const host = await hostModel.capture(execution);
    const offered = await hostModel.reasoningEfforts(host, execution.signal);
    if (!['high', 'off'].every(effort => offered.includes(effort))) {
      throw new Error('请在支持 High 和 Off 的 DSH 模型对话里运行小样本。');
    }
    const request = { action: 'review-sample', indexPath: item.indexPath, sample, _host_model: host.selection };
    const lock = process.platform === 'win32' ? item.indexPath.toLowerCase() : item.indexPath;
    execution.signal?.throwIfAborted();
    if (locks.has(lock)) throw new Error('该技能库已有建图或复核小样本作业在运行。');
    locks.add(lock);
    try {
      const id = ctx.jobs.start({ kind: 'skillnet-review-sample', label: 'SkillNet 关系复核小样本', owner: execution.agent?.id,
        outputLimitBytes: 24 * 1024, run(job) {
          const controller = new AbortController();
          const done = (async () => {
            try {
              const results = {};
              for (const effort of ['high', 'off']) {
                const selection = { ...host, selection: { ...host.selection, reasoningEffort: effort } };
                let calls = 0;
                job.updateProgress(effort.toUpperCase() + ' · 关系复核小样本');
                const invoke = createAnalysisPacer((payload, signal) => {
                  calls++;
                  return hostModel.invoke(selection, payload, signal, () => job.updateProgress(effort.toUpperCase() + ' · ' + payload.label));
                }, message => job.updateProgress(effort.toUpperCase() + ' · ' + message));
                const started = performance.now();
                const result = await run(request, controller.signal, invoke);
                const seconds = (performance.now() - started) / 1000;
                results[effort] = { ...result, calls, seconds: Math.round(seconds * 10) / 10,
                  pairsPerMinute: Math.round(result.completed * 600 / seconds) / 10 };
              }
              const signature = decision => {
                if (!decision) return 'unresolved';
                if (decision.outcome === 'none') return 'none';
                return decision.relations.map(edge => [edge.type, edge.source, edge.target].join(':')).sort().join(',');
              };
              const changed = results.high.pairs.flatMap((row, index) => {
                const high = signature(row.decision);
                const off = signature(results.off.pairs[index].decision);
                return high === off ? [] : [{ skills: row.skills, high, off }];
              });
              const directory = join(root, 'artifacts', job.id);
              await mkdir(directory, { recursive: true });
              const report = join(directory, 'comparison.json');
              await writeFile(report, JSON.stringify({ model: host.selection, sample, results, changed }, null, 2));
              const metrics = ({ completed, calls, seconds, pairsPerMinute }) => ({ completed, calls, seconds, pairsPerMinute });
              return { status: 'completed', result: JSON.stringify({ pairs: sample.pairs.length,
                high: metrics(results.high), off: metrics(results.off), changed, report }) };
            } catch (error) {
              return controller.signal.aborted ? { status: 'killed', detail: '复核小样本已取消。' } : { status: 'failed', detail: error.message };
            } finally {
              locks.delete(lock);
            }
          })();
          return { done, cancel: () => controller.abort() };
        },
      });
      return { id, status: 'running', pairs: sample.pairs.length };
    } catch (error) {
      locks.delete(lock);
      throw error;
    }
  }
  async function routeContext(task, signal) {
    const item = await selected({ libraryId: task.libraryId });
    const current = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
    if (task.retrievalMode === 'model') {
      const versions = task.result.source_versions;
      if (!versions || Object.keys(versions).length !== current.source.skills.length || current.source.skills.some(skill =>
        typeof skill.source !== 'string' || versions[skill.id] !== createHash('sha256').update(skill.source).digest('hex'))) {
        throw new Error('技能库已改变，请重新运行路由。');
      }
    } else {
      const issue = vectorRouteIssue(current);
      if (issue) throw new Error(issue);
    }
    return { item, current };
  }
  async function skillSourcePath(item, skill) {
    const source = skill.path || join(item.sourcePath, skill.id);
    const expected = await realpath(basename(source) === 'SKILL.md' ? source : join(source, 'SKILL.md'));
    const rel = relative(item.sourcePath, expected);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error('技能路径不在当前库中。');
    }
    return expected;
  }
  async function routePicks(item, current, picks) {
    return Promise.all(picks.map(async skill => {
      const local = current.source.skills.find(value => value.id === skill.skill_id);
      if (!local) throw new Error('路由结果已过期，请重新运行。');
      return { ...skill, name: local.name, path: dirname(await skillSourcePath(item, local)) };
    }));
  }
  function currentUserMessage(agent) {
    return ctx.sessions?.get(agent.id)?.deriveMessages().findLast(message =>
      message.role === 'user' && message.source?.kind === 'user');
  }
  function routeCache(agent, messageId) {
    if (!messageId) return new Map();
    if (turnRoutes.get(agent)?.messageId !== messageId) turnRoutes.set(agent, { messageId, entries: new Map() });
    return turnRoutes.get(agent).entries;
  }
  function reuseRoute(agent, entry) {
    if (entry.pending) recentRoutes.set(agent, entry.pending);
    else recentRoutes.delete(agent);
    return { ...entry.response, reused: true };
  }
  async function finishRoute(agent, signal, messageId, items, response, cache, keys) {
    const result = await rememberRoute(agent, signal, messageId, items, response);
    if (result.skills.length) {
      const entry = { response: result, pending: recentRoutes.get(agent) };
      for (const key of keys) cache.set(key, entry);
    }
    return result;
  }
  async function inConversation(execution, operation) {
    const { agent, signal } = execution;
    if (!agent) throw new Error('请在当前 DSH 对话中调用技能路由。');
    signal.throwIfAborted();
    if (activeRoutes.has(agent)) throw new Error('当前对话已有技能路由正在处理，请等它结束。');
    activeRoutes.add(agent);
    try { return await operation(agent, signal); }
    finally { activeRoutes.delete(agent); }
  }
  function routeLoadIssue(skill, code, actualPath) {
    return { skillId: skill.skill_id, name: skill.name, code, message: loadingMessages[code] || loadingMessages.native_check_failed,
      expectedPath: join(skill.path, 'SKILL.md'), ...(skill.library && { library: skill.library }),
      ...(actualPath ? { actualPath } : {}) };
  }
  function loadResult(status, loadStage, loaded = [], blocked = [], unattemptedSkillIds = []) {
    return { status, loadStage, loaded, loadedSkillIds: loaded.map(skill => skill.skillId), blocked, unattemptedSkillIds };
  }
  async function loadRouteSkills(item, picks, agent, signal) {
    let cwd;
    try { cwd = await ctx.workingDirectory.ensure(agent, signal); }
    catch {
      signal.throwIfAborted();
      return loadResult('blocked', 'preflight', [], picks.map(skill => routeLoadIssue(skill, 'scope_unavailable')));
    }
    const verified = [], blocked = [];
    for (const skill of picks) {
      signal.throwIfAborted();
      try {
        const definition = await library.resolveRouteSkill({ libraryId: skill.library?.id ?? item.id, skillId: skill.skill_id, name: skill.name,
          expectedPath: join(skill.path, 'SKILL.md'), cwd, scope: agent, signal, invocation: 'modelInvocable' });
        if (definition.code) blocked.push(routeLoadIssue(skill, definition.code, definition.entry?.path));
        else verified.push({ skill, effectivePath: definition.effectivePath });
      } catch {
        signal.throwIfAborted();
        blocked.push(routeLoadIssue(skill, 'native_check_failed'));
      }
    }
    if (blocked.length) return loadResult('blocked', 'preflight', [], blocked, verified.map(({ skill }) => skill.skill_id));
    const loaded = [];
    for (const { skill, effectivePath } of verified) {
      signal.throwIfAborted();
      let reply;
      try {
        const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID(), name: 'skill', arguments: JSON.stringify({ name: skill.name }) }], agent, signal });
        reply = batch.results[0]?.result;
      } catch { signal.throwIfAborted(); }
      signal.throwIfAborted();
      let code;
      if (!reply || reply.isError || reply.value?.name !== skill.name || !reply.value.content || !reply.content?.length) code = 'native_load_failed';
      const base = reply?.value?.resourceBase;
      const actualPath = base?.kind === 'directory' && typeof base.path === 'string' ? base.path : undefined;
      if (!code && base?.kind === 'directory' && !same(actualPath, dirname(effectivePath))) code = 'native_loaded_path_mismatch';
      if (code) {
        const unattempted = picks.slice(loaded.length + 1).map(value => value.skill_id);
        return loadResult(loaded.length ? 'partial' : 'blocked', 'invocation', loaded,
          [routeLoadIssue(skill, code, actualPath ? join(actualPath, 'SKILL.md') : undefined)], unattempted);
      }
      loaded.push({ skillId: skill.skill_id, name: skill.name, effectivePath, content: reply.content,
        ...(skill.library && { library: skill.library }) });
    }
    return loadResult('loaded', 'invocation', loaded);
  }
  function routeResponse(item, request, skills, usage, loading) {
    const next = {
      no_match: '未找到适合的技能。继续处理原任务，无需自动安装或重复路由。',
      recommended: '名单已选定。直接向用户交付名单和理由，本轮不要再调用路由。用户在新消息要求执行时，可继续使用本次选择。',
      loaded: '技能指令已加载。用这些指令继续执行原任务，本轮不要再为相同范围路由。',
      blocked: '简要说明选中的技能、哪些未能加载以及原因。若未安装，请用户在工作台安装所缺技能，再在本对话说「继续」。本轮不要再路由。无需展示内部编号或路径。',
      partial: '简要说明哪些技能已加载、哪些还需要处理，再请用户在本对话说「继续」。本轮不要再路由。无需展示内部编号或路径。',
    }[loading.status];
    return { library: item ? librarySummary(item) : null, query: request.query, retrievalMode: request.retrievalMode,
      ...(request.libraryScope && { libraryScope: request.libraryScope }),
      ...(request.libraries && { libraries: request.libraries }),
      ...(request.libraryReason && { libraryReason: request.libraryReason }),
      skills, ...(usage !== undefined && { usage }), ...loading, next };
  }
  async function packageVersions(skills, signal) {
    return Promise.all(skills.map(skill => library.sourcePackageVersion(join(skill.path, 'SKILL.md'), signal)));
  }
  async function rememberRoute(agent, signal, messageId, items, response) {
    recentRoutes.delete(agent);
    if (!messageId || !['recommended', 'blocked', 'partial'].includes(response.status)) return response;
    let versions;
    try { versions = await packageVersions(response.skills, signal); }
    catch {
      signal.throwIfAborted();
      return { ...response, next: response.next + ' 无法保留来源包版本，使用这些技能前需要重新路由。' };
    }
    signal.throwIfAborted();
    const resumeId = randomUUID();
    const origins = new Map(items.map(item => [item.id, item.sourcePath]));
    const { library, libraryScope, libraries, libraryReason, query, retrievalMode, skills } = response;
    recentRoutes.set(agent, { resumeId, messageId, origins, library, libraryScope, libraries, libraryReason,
      query, retrievalMode, skills, versions });
    return { ...response, resumeId };
  }
  function libraryClarification(agent, query, { libraries, reason, libraryReason }) {
    recentRoutes.delete(agent);
    return { ...loadResult('needs_library', null), query, library: null, retrievalMode: null, skills: [], reason,
      libraries: libraries.map(({ id, name, sourcePath }) => ({ id, name, sourcePath })),
      ...(libraryReason && { libraryReason }),
      next: '请用自然语言向用户确认要用的技能库。同名库可按需用路径区分。回复后等用户的新消息，再运行路由。' };
  }
  async function routeLibraryGroups(items, signal) {
    const groups = [];
    for (const connection of items) {
      signal.throwIfAborted();
      const item = await selected({ libraryId: connection.id });
      const { source } = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
      groups.push({ item, skills: source.skills });
    }
    return groups;
  }
  async function getCrossLibraries(args, signal) {
    const libraries = await listLibraries();
    if (args.libraryId !== undefined || args.libraryName !== undefined) {
      return { libraries, reason: 'conflicting_library_scope' };
    }
    let selectedLibraries = libraries;
    if (args.libraryNames !== undefined) {
      if (!Array.isArray(args.libraryNames) || args.libraryNames.length > libraries.length) {
        return { libraries, reason: 'cross_library_members_required' };
      }
      const items = new Map();
      for (const libraryName of args.libraryNames) {
        const resolution = await conversationLibrary({ libraryName }, signal);
        if (!resolution.item) return resolution;
        items.set(resolution.item.id, resolution.item);
      }
      selectedLibraries = [...items.values()];
    }
    return selectedLibraries.length >= 2 ? { items: selectedLibraries } : { libraries, reason: 'cross_library_members_required' };
  }
  async function routeCombined(args, query, execution, agent, signal, message, cache) {
    const resolution = await getCrossLibraries(args, signal);
    if (!resolution.items) return libraryClarification(agent, query, resolution);
    if (args.retrievalMode === 'vector') throw new Error('跨库匹配从各库当前源码选择，请使用自动或仅使用模型。');
    const { items } = resolution;
    const key = 'combine:' + items.map(item => item.id).sort().join(',');
    if (cache.has(key)) return reuseRoute(agent, cache.get(key));
    const host = await captureRouteModel(execution);
    const groups = await routeLibraryGroups(items, signal);
    const k = routeLimit(args.k, message);
    const combined = await exploreLibraries(groups, { query, k, combine: true },
      (payload, modelSignal) => hostModel.invoke(host, payload, modelSignal), signal);
    if (combined.narrow) return libraryClarification(agent, query, {
      libraries: items, reason: 'cross_library_scope_too_large', libraryReason: combined.reason,
    });
    const picked = new Map();
    const picks = [];
    for (const { item, skill, reason } of combined.picks) {
      if (!picked.has(item.id)) {
        const [group] = await routeLibraryGroups([item], signal);
        if (!same(group.item.sourcePath, item.sourcePath)) throw new Error('技能库路径已改变，请重新路由。');
        picked.set(item.id, group);
      }
      const current = picked.get(item.id).skills.find(value => value.id === skill.id);
      if (!current || current.source !== skill.source) throw new Error('已选技能源码已改变，请重新路由。');
      const path = dirname(await skillSourcePath(item, current));
      picks.push({ skill_id: current.id, name: current.name, path, reason, library: librarySummary(item) });
    }
    const request = { query, retrievalMode: 'model', libraryScope: 'combine', libraries: items.map(librarySummary) };
    signal.throwIfAborted();
    const loading = !picks.length ? loadResult('no_match', null) : args.loadSkills === false
      ? loadResult('recommended', null) : await loadRouteSkills(null, picks, agent, signal);
    return finishRoute(agent, signal, message?.id, items, routeResponse(null, request, picks, undefined, loading), cache, [key]);
  }
  async function routeConversation(args, execution) {
    return inConversation(execution, async (agent, signal) => {
      const query = text(args.query, '任务');
      const message = currentUserMessage(agent);
      const cache = routeCache(agent, message?.id);
      if (cache.has('clarification')) return reuseRoute(agent, cache.get('clarification'));
      if (args.libraryScope === 'combine') return routeCombined(args, query, execution, agent, signal, message, cache);
      if (args.libraryNames !== undefined) throw new Error('指定参与库列表时，请使用跨库匹配。');
      let resolved = await conversationLibrary(args, signal);
      let choice, capturedHost;
      if (resolved.reason === 'library_required') {
        if (cache.has('auto')) return reuseRoute(agent, cache.get('auto'));
        capturedHost = await captureRouteModel(execution);
        const groups = await routeLibraryGroups(resolved.libraries, signal);
        choice = await exploreLibraries(groups, { query, combine: false },
          (payload, modelSignal) => hostModel.invoke(capturedHost, payload, modelSignal), signal);
        if (choice.libraryId) resolved = await conversationLibrary({ libraryId: choice.libraryId }, signal);
        else resolved = { ...resolved, reason: 'uncertain_library', libraryReason: choice.reason };
      }
      signal.throwIfAborted();
      if (!resolved.item) {
        const result = libraryClarification(agent, query, resolved);
        if (resolved.reason === 'uncertain_library') cache.set('clarification', { response: result });
        return result;
      }
      const key = 'library:' + resolved.item.id;
      if (cache.has(key)) {
        if (choice) cache.set('auto', cache.get(key));
        return reuseRoute(agent, cache.get(key));
      }
      const k = routeLimit(args.k, message);
      const { item, request, host } = await prepare({ ...args, action: 'route', query, k, libraryId: resolved.item.id, retrievalMode: args.retrievalMode ?? 'auto' }, execution, capturedHost);
      const result = await configured(request, signal, (payload, modelSignal) => hostModel.invoke(host, payload, modelSignal));
      const { current } = await routeContext({ libraryId: item.id, retrievalMode: request.retrievalMode, result }, signal);
      const picks = await routePicks(item, current, result.skills);
      signal.throwIfAborted();
      let loading;
      if (!picks.length) loading = loadResult('no_match', null);
      else if (args.loadSkills === false) loading = loadResult('recommended', null);
      else loading = await loadRouteSkills(item, picks, agent, signal);
      const context = choice ? { ...request, libraryScope: 'auto', libraryReason: choice.reason } : request;
      return finishRoute(agent, signal, message?.id, [item], routeResponse(item, context, picks, result.usage, loading), cache, choice ? [key, 'auto'] : [key]);
    });
  }
  async function continueConversationRoute(args, execution) {
    return inConversation(execution, async (agent, signal) => {
      const pending = recentRoutes.get(agent);
      if (!pending || pending.resumeId !== args.resumeId) throw new Error('当前对话没有这份可继续的选择结果，请重新路由。');
      const messageId = currentUserMessage(agent)?.id;
      if (!messageId || messageId === pending.messageId) throw new Error('请等用户在本对话明确要求继续，再加载选中的技能。');
      pending.messageId = messageId;
      const current = new Map();
      const picks = [];
      let versions;
      try {
        for (const skill of pending.skills) {
          const id = skill.library?.id ?? pending.library.id;
          if (!current.has(id)) {
            const item = await selected({ libraryId: id });
            if (!same(item.sourcePath, pending.origins.get(id))) throw new Error('技能库路径已改变。');
            const data = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
            current.set(id, { item, data });
          }
          const { item, data } = current.get(id);
          picks.push(...await routePicks(item, data, [skill]));
        }
        versions = await packageVersions(picks, signal);
      } catch (error) {
        signal.throwIfAborted();
        recentRoutes.delete(agent);
        throw new Error('无法确认上次选择的技能来源，请重新路由。', { cause: error });
      }
      if (versions.some((version, i) => version !== pending.versions[i] || !same(picks[i].path, pending.skills[i].path))) {
        recentRoutes.delete(agent);
        throw new Error('上次选择的技能包已变化，请重新路由。');
      }
      const loading = await loadRouteSkills(pending.library, picks, agent, signal);
      const result = routeResponse(pending.library, pending, picks, undefined, loading);
      if (loading.status === 'loaded') { recentRoutes.delete(agent); return result; }
      return { ...result, resumeId: pending.resumeId };
    });
  }
  async function useRoute(args, signal) {
    const { ready, ...handoff } = await prepareRouteHandoff(args, signal);
    if (!ready) return { accepted: false, ...handoff };
    return hostModel.use({ query: handoff.query, skills: handoff.skills }, handoff.sessionId, signal);
  }
  async function routeDraft(args, signal) {
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim()) throw new Error('请先选择要使用的 DSH 对话。');
    const handoff = await prepareRouteHandoff(args, signal);
    if (!handoff.ready) return handoff;
    const references = handoff.skills.map(skill => `- ${skill.name}（生效目录 ${skill.path}）`);
    const prompt = [
      `请先加载工作台从「${handoff.libraryName}」为下列任务选出的技能，核对各技能的生效目录，再继续任务。`,
      ...references,
      '',
      handoff.query,
    ].join('\n');
    return { ready: true, sessionId: handoff.sessionId, prompt };
  }
  async function installPreview(item, local, expected, code, signal) {
    if (same(item.sourcePath, join(library.home, 'skills')) || !['native_missing', 'native_path_mismatch'].includes(code)) return;
    return library.prepareLocal(dirname(expected), signal, { libraryId: item.id, skillId: local.id });
  }
  async function skillInConversation(args, signal) {
    const item = await selected(args);
    const current = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
    const skill = current.source.skills.find(skill => skill.id === args.skillId);
    if (!skill) throw new Error('这个技能已不在当前库中，请刷新技能库。');
    const agent = await hostModel.agentFor(args.sessionId, signal);
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const expected = await skillSourcePath(item, skill);
    return { item, skill, agent, cwd, expected };
  }
  async function skillStatus(args, signal) {
    const { item, skill, agent, cwd, expected } = await skillInConversation(args, signal);
    const lookup = { libraryId: item.id, skillId: skill.id, name: skill.name, expectedPath: expected, cwd, scope: agent, signal };
    let definition = await library.resolveRouteSkill({ ...lookup, invocation: 'modelInvocable' });
    if (definition.code === 'native_not_invocable' && definition.entry?.invocation?.userInvocable) {
      definition = await library.resolveRouteSkill({ ...lookup, invocation: 'userInvocable' });
    }
    const { entry, effectivePath, code } = definition;
    signal?.throwIfAborted();
    return { status: code ? 'unavailable' : 'available', sourcePath: item.sourcePath, expectedPath: expected,
      modelInvocable: !code && entry.invocation?.modelInvocable === true,
      userInvocable: !code && entry.invocation?.userInvocable === true,
      ...(entry?.path ? { actualPath: entry.path } : {}), ...(effectivePath ? { effectivePath } : {}),
      ...(code ? { code, message: loadingMessages[code] || loadingMessages.native_check_failed } : {}) };
  }
  async function useSkill(args, signal) {
    const { item, skill, agent, cwd, expected } = await skillInConversation(args, signal);
    const { entry, effectivePath, code } = await library.resolveRouteSkill({ libraryId: item.id, skillId: skill.id, name: skill.name,
      expectedPath: expected, cwd, scope: agent, signal, invocation: 'userInvocable' });
    if (code) {
      const preview = args.preview === false ? undefined : await installPreview(item, skill, expected, code, signal);
      return { ready: false, code, message: loadingMessages[code] || loadingMessages.native_check_failed,
        ...(entry?.path ? { actualPath: entry.path } : {}), ...(preview ? { preview } : {}) };
    }
    signal?.throwIfAborted();
    return { ready: true, sessionId: agent.id, reference: `/${entry.name || skill.name} `,
      skill: { name: skill.name, path: effectivePath, userInvocable: true, modelInvocable: entry.invocation?.modelInvocable === true } };
  }
  async function prepareRouteHandoff(args, signal) {
    const task = await getTask(args.id);
    if (task.action !== 'route' || task.status !== 'completed' || !task.result?.skills?.length) throw new Error('请选择已有技能结果的已完成路由。');
    const { item, current } = await routeContext(task, signal);
    const agent = await hostModel.agentFor(args.sessionId || task.sessionId, signal);
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const skills = [];
    for (const skill of task.result.skills) {
      const local = current.source.skills.find(item => item.id === skill.skill_id);
      if (!local) throw new Error('路由结果已过期，请重新运行。');
      const expected = await skillSourcePath(item, local);
      const { entry, effectivePath, code } = await library.resolveRouteSkill({ libraryId: item.id, skillId: local.id, name: local.name,
        expectedPath: expected, cwd, scope: agent, signal, invocation: 'modelInvocable' });
      if (code) {
        const preview = args.preview === false ? undefined : await installPreview(item, local, expected, code, signal);
        return { ready: false, code, skillId: local.id, sourcePath: item.sourcePath,
          message: `技能「${local.name}」：${loadingMessages[code] || loadingMessages.native_check_failed}`,
          ...(entry?.path ? { actualPath: entry.path } : {}), ...(preview ? { preview } : {}) };
      }
      skills.push({ ...skill, name: local.name, path: dirname(effectivePath) });
    }
    signal?.throwIfAborted();
    return { ready: true, sessionId: agent.id, libraryName: item.name, query: task.query, skills };
  }
  async function createDefault() {
    const sourcePath = join(library.home, 'skills');
    await mkdir(sourcePath, { recursive: true });
    return { sourcePath };
  }
  async function config() {
    const lastPath = (await read('workspace.json', {})).lastPath;
    return lastPath ? { sourcePath: lastPath } : createDefault();
  }
  const analysisConversation = createAnalysisConversation(ctx, { root, selected, configured, hostModel, locks });
  return { configured, start, reviewSample, analysisConversation, routeConversation, continueConversationRoute, settings, listLibraries, connect, forget, tasks, getTask, latestEvaluation, publish, useRoute, routeDraft, useSkill, skillStatus, createDefault, createNamed, installTargets, install, config,
    async cancel(args) { const task = await getTask(args.id); if (!['running', 'stopping'].includes(task.status)) return task; await ctx.jobs.kill(task.id, task.owner, '已从 SkillNet 面板取消'); return getTask(task.id); },
  };
}
