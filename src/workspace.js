import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTaskStore } from './task-store.js';
import { createAnalysisConversation } from './analysis-conversation.js';

const secrets = ['api_key', 'embedding_api_key', 'explorer_api_key', 'github_token'];
const fields = ['base_url', 'model', 'embedding_base_url', 'embedding_model', 'explorer_base_url', 'explorer_model', 'json_mode', 'skillnet_api_url', 'github_mirror'];
const settingNames = { api_key: '分析模型 API 密钥', embedding_api_key: '向量模型 API 密钥', embedding_base_url: '向量模型地址', embedding_model: '向量模型名称', explorer_api_key: 'DSH 探索器 API 密钥', explorer_base_url: 'DeepSeek Messages 地址', explorer_model: '探索器模型名称' };
const actionNames = { analyze: '建图', route: '任务路由', create: '创建技能', evaluate: '评估技能' };
const credential = key => `DSH_SKILLNET_${key.toUpperCase()}`;
const same = (a, b) => Boolean(a && b) && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const text = (value, name, limit = 100_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${name}不能为空或超过长度限制。`);
  return value.trim();
};

export function createWorkspace(ctx, run, library, hostModel) {
  const root = join(library.home, 'skillnet');
  const taskStore = createTaskStore(root);
  let mutation = Promise.resolve();
  const locks = new Set();
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
  async function configured(request, signal, invokeHost) {
    if (request.action === 'local-library') return run(request, signal);
    if (request.action === 'discover') {
      const { skillnet_api_url } = await read('settings.json', {});
      return run({ ...request, _settings: { skillnet_api_url } }, signal);
    }
    const settings = { ...await read('settings.json', {}), explorer_backend: 'dsh' };
    for (const key of secrets) {
      const found = await ctx.credentials.resolve(credential(key));
      if (found) settings[key] = found.value;
    }
    if (request._host_model || request.action === 'analysis-step') { delete settings.api_key; delete settings.explorer_api_key; }
    return run({ ...request, _settings: settings }, signal, invokeHost);
  }
  async function settings(args = {}, signal) {
    if (args.values) await serial(async () => {
      const values = await read('settings.json', {});
      for (const [key, value] of Object.entries(args.values)) {
        if (![...fields, ...secrets].includes(key) || typeof value !== 'string') throw new Error('未知的配置字段。');
        if (value.length > 4096) throw new Error('配置值过长。');
        if (fields.includes(key)) {
          if ((key.endsWith('base_url') || key.endsWith('api_url') || key === 'github_mirror') && value) {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含凭据和查询参数的 HTTP(S) 地址。');
          }
          if (key === 'json_mode' && !['auto', 'on', 'off', ''].includes(value)) throw new Error('JSON 模式无效。');
          if (value.trim()) values[key] = value.trim(); else delete values[key];
        }
      }
      // Validate the complete non-secret settings before committing credentials.
      for (const key of secrets) if (args.values[key]?.trim()) await ctx.credentials.set(credential(key), args.values[key].trim());
      for (const key of args.clearSecrets || []) if (secrets.includes(key)) await ctx.credentials.unset(credential(key));
      await save('settings.json', values);
    });
    return configured({ action: 'settings' }, signal);
  }
  async function connect(args, signal) {
    return serial(async () => {
      if (!isAbsolute(args.sourcePath || '')) throw new Error('请填写技能库的绝对路径。');
      const sourcePath = await realpath(args.sourcePath);
      const state = await read('workspace.json', { libraries: [] });
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
      const item = { id: previous?.id || randomUUID(), name: same(sourcePath, join(library.home, 'skills')) ? 'DSH 个人技能库' : basename(sourcePath), sourcePath, indexPath };
      state.libraries = [...state.libraries.filter(x => x.id !== item.id), item];
      state.lastPath = sourcePath;
      await save('workspace.json', state);
      return { ...data, analysisRevision, connection: item };
    });
  }
  async function listLibraries() { return (await read('workspace.json', { libraries: [] })).libraries; }
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
  async function latestEvaluation(args) {
    const item = await selected(args);
    const page = await taskStore.list({ sourcePath: item.sourcePath, skillId: text(args.skillId, '技能标识'), action: 'evaluate', status: 'completed', limit: 1 });
    return page.items.length ? getTask(page.items[0].id) : null;
  }
  async function prepare(args, execution) {
    const action = args.action;
    if (!['analyze', 'route', 'create', 'evaluate'].includes(action)) throw new Error('未知的作业类型。');
    const item = action === 'create' ? null : await selected(args);
    const request = { action };
    if (['analyze', 'route'].includes(action)) {
      request.retrievalMode = args.retrievalMode ?? 'model';
      if (!['model', 'vector'].includes(request.retrievalMode)) throw new Error('请选择仅使用模型或向量检索模式。');
    }
    const host = hostModel && args.modelSource !== 'sdk' ? await hostModel.capture(execution, args.sessionId) : null;
    if (host) request._host_model = host.selection;
    if (item) Object.assign(request, { sourcePath: item.sourcePath, indexPath: item.indexPath });
    if (action === 'route') {
      request.query = text(args.query, '任务');
      request.k = Math.max(1, Math.min(20, Number(args.k) || 5));
      const data = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, execution.signal);
      if (!data.source.skills.length) throw new Error('技能库中还没有可用技能。');
      if (request.retrievalMode === 'vector') {
        if (!data.graph || data.analysisError) throw new Error('请先启用向量检索并成功建图，再运行向量路由。');
        if (data.graph.embedding_model === '') throw new Error('当前图谱不含向量索引，请启用向量检索后重新建图。');
        if (data.changedSkills || data.addedSkills || data.removedSkills) throw new Error('技能文件有变化，请先重新建图。');
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
      const candidate = await realpath(skill.path || join(item.sourcePath, skill.id));
      const rel = relative(item.sourcePath, candidate);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('技能路径不在当前库中。');
      request.path = candidate.endsWith('SKILL.md') ? resolve(candidate, '..') : candidate;
    }
    // Preflight endpoints before allocating a job. SDK validates each endpoint independently.
    const current = await settings({}, execution.signal);
    const vectors = ['embedding_api_key', 'embedding_base_url', 'embedding_model'];
    const required = [
      ...(!host ? action === 'route' ? ['explorer_api_key', 'explorer_base_url', 'explorer_model'] : ['api_key'] : []),
      ...(request.retrievalMode === 'vector' ? vectors : []),
    ];
    const missing = required.filter(key => !current.fields[key]?.value);
    if (missing.length) throw new Error(`请先在设置中配置：${missing.map(key => settingNames[key] || key).join('、')}`);
    return { action, item, request, host };
  }
  async function start(args, execution = {}) {
    const { action, item, request, host } = await prepare(args, execution);
    const lock = action === 'analyze' ? (process.platform === 'win32' ? item.indexPath.toLowerCase() : item.indexPath) : null;
    if (lock && locks.has(lock)) throw new Error('这个技能库正在建图。');
    if (lock) locks.add(lock);
    try {
      const id = ctx.jobs.start({ kind: `skillnet-${action}`, label: `SkillNet ${actionNames[action]}${item ? ` / ${item.name}` : ''}`, owner: execution.agent?.id, outputLimitBytes: 24 * 1024,
        run(job) {
          const controller = new AbortController();
          const record = { id: job.id, action, skillId: action === 'evaluate' ? args.skillId : undefined, retrievalMode: request.retrievalMode, query: request.query, owner: execution.agent?.id, libraryId: item?.id, sourcePath: item?.sourcePath, model: host?.selection, sessionId: host?.sessionId, modelSessions: [], status: 'running', startedAt: new Date().toISOString() };
          job.updateProgress(`正在${actionNames[action]}`);
          const done = (async () => {
            try {
              await taskStore.write(record);
              const artifacts = join(root, 'artifacts', job.id);
              await mkdir(artifacts, { recursive: true });
              if (action === 'create') request.output_dir = join(artifacts, 'drafts');
              if (action === 'evaluate') request.cache_dir = join(artifacts, 'evaluation');
              record.result = await configured(request, controller.signal, host ? (payload, signal) => hostModel.invoke(host, payload, signal, async id => { record.modelSessions.push(id); if (payload.label) job.updateProgress(`正在${payload.label}`); await taskStore.write(record); }) : undefined);
              record.status = 'completed';
            } catch (error) {
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
            return { status: record.status, detail: record.error, result: JSON.stringify({ ...record, result }) };
          })();
          return { done, cancel: () => controller.abort() };
        },
      });
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
  async function routeContext(task, signal) {
    const item = await selected({ libraryId: task.libraryId });
    const current = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
    if (task.retrievalMode === 'model') {
      const versions = task.result.source_versions;
      if (!versions || Object.keys(versions).length !== current.source.skills.length || current.source.skills.some(skill =>
        typeof skill.source !== 'string' || versions[skill.id] !== createHash('sha256').update(skill.source).digest('hex'))) {
        throw new Error('技能库已改变，请重新运行路由。');
      }
    } else if (!current.graph || current.analysisError || current.changedSkills || current.addedSkills || current.removedSkills) {
      throw new Error('技能库或索引已改变，请重新建图和路由。');
    }
    return { item, current };
  }
  async function routeConversation(args, execution, native) {
    if (!execution.agent) throw new Error('请在当前 DSH 对话中调用技能路由。');
    execution.signal.throwIfAborted();
    // An ordinary conversation does not need to open the panel to connect the
    // default library. An explicitly selected library still takes precedence.
    const libraryId = args.libraryId || (await connect(await config(), execution.signal)).connection.id;
    const { item, request, host } = await prepare({ ...args, action: 'route', libraryId }, execution);
    const result = await configured(request, execution.signal, (payload, signal) => hostModel.invoke(host, payload, signal));
    const { current } = await routeContext({ libraryId: item.id, retrievalMode: request.retrievalMode, result }, execution.signal);
    const cwd = await ctx.workingDirectory.ensure(execution.agent, execution.signal);
    const selected = [];
    // Validate the effective native definitions for this Agent before loading
    // any instructions. A project override must not silently replace a pick.
    for (const skill of result.skills) {
      const local = current.source.skills.find(value => value.id === skill.skill_id);
      if (!local) throw new Error('路由结果已过期，请重新运行。');
      const path = await realpath(local.path || join(item.sourcePath, local.id));
      const expected = path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md');
      const entry = await native.get(local.name, { cwd, scope: execution.agent, signal: execution.signal });
      if (!entry?.invocation?.modelInvocable || !same(entry.path, expected)) throw new Error(`技能 ${local.name} 尚未在当前对话生效，或被同名技能覆盖。请检查安装与调用权限。`);
      selected.push({ ...skill, name: local.name, path: dirname(expected) });
    }
    const loaded = [];
    for (const skill of selected) {
      execution.signal.throwIfAborted();
      const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID(), name: 'skill', arguments: JSON.stringify({ name: skill.name }) }], agent: execution.agent, signal: execution.signal });
      const reply = batch.results[0]?.result;
      if (!reply || reply.isError || reply.value?.name !== skill.name || !reply.value.content || !reply.content?.length) throw new Error(`未能在当前对话加载技能 ${skill.name}。${reply?.error?.message || ''}`);
      loaded.push({ name: skill.name, content: reply.content });
    }
    return { query: request.query, skills: selected, loaded, usage: result.usage,
      next: selected.length ? '已通过当前对话的原生 skill 工具加载以下完整指令。结合原任务继续执行，遵守用户要求；无需再次选对话、加载或路由。' : '未找到适合的技能。继续处理原任务，不要为了凑数选择技能或自动搜索、安装。' };
  }
  async function useRoute(args, native, signal) {
    const task = await getTask(args.id);
    if (task.action !== 'route' || task.status !== 'completed' || !task.result?.skills?.length) throw new Error('请选择已有技能结果的已完成路由。');
    const { item, current } = await routeContext(task, signal);
    return handoff(item, current, { query: task.query, skills: task.result.skills }, args.sessionId || task.sessionId, native, signal);
  }
  async function useSkill(args, native, signal) {
    const item = await selected(args);
    const current = await configured({ action: 'local-library', sourcePath: item.sourcePath, indexPath: item.indexPath }, signal);
    const skill = current.source.skills.find(skill => skill.id === args.skillId);
    if (!skill) throw new Error('这个技能已不在当前库中，请刷新技能库。');
    const agent = await hostModel.agentFor(args.sessionId, signal);
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const path = await realpath(skill.path || join(item.sourcePath, skill.id));
    const expected = path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md');
    const entry = await native.get(skill.name, { cwd, scope: agent, signal });
    if (!entry?.invocation?.userInvocable || !same(entry.path, expected)) {
      return { ready: false, preview: await library.prepareLocal(dirname(expected), signal), message: '这个技能尚未在目标对话中生效，请先预览并安装，或检查同名覆盖与调用权限。' };
    }
    signal?.throwIfAborted();
    return { ready: true, sessionId: agent.id, reference: `/${entry.name || skill.name} `, skill: { name: skill.name, path: expected } };
  }
  async function handoff(item, current, selection, sessionId, native, signal) {
    const agent = await hostModel.agentFor(sessionId, signal);
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const skills = [];
    for (const skill of selection.skills) {
      const local = current.source.skills.find(item => item.id === skill.skill_id);
      if (!local) throw new Error('路由结果已过期，请重新运行。');
      const path = await realpath(local.path || join(item.sourcePath, local.id));
      const entry = await native.get(local.name, { cwd, scope: agent, signal });
      const expected = path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md');
      if (!entry?.invocation?.modelInvocable || !same(entry.path, expected)) {
        return { accepted: false, preview: await library.prepareLocal(path.endsWith('SKILL.md') ? dirname(path) : path, signal), message: '这个技能尚未在目标对话中生效，请先预览并安装，或检查同名覆盖与预设。' };
      }
      skills.push({ ...skill, name: local.name, path: dirname(expected) });
    }
    signal?.throwIfAborted();
    return hostModel.use({ ...selection, skills }, sessionId, signal);
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
  return { configured, start, analysisConversation, routeConversation, settings, listLibraries, connect, forget, tasks, getTask, latestEvaluation, publish, useRoute, useSkill, createDefault, config,
    async cancel(args) { const task = await getTask(args.id); if (!['running', 'stopping'].includes(task.status)) return task; await ctx.jobs.kill(task.id, task.owner, '已从 SkillNet 面板取消'); return getTask(task.id); },
  };
}
