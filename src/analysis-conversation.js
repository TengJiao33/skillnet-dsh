import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userMessage } from './host-model.js';

const instructions = [
  '建图分两个阶段进行：先逐个提炼技能的能力画像（输入、输出、工具、使用场景和限制），再根据画像和源码判断候选技能之间是否存在先后配合（compose_with）或功能相近（similar_to）的关系。',
  '所需的技能源码、判断标准和字段格式都会随每一步任务返回，不需要自行查看本地目录或文件。',
  '每拿到一步任务，聚焦当前这一步的内容完成分析，调用 skillnet_analyze_submit 提交结果，拿到下一步后继续。思考时概括关键信息即可，不必逐行复述源码。',
  '如果某一步未通过校验，工具会返回具体原因，直接在当前对话修正这一步并重交即可。全部步骤完成后，用简体中文简要说明本次分析的技能数量和主要关系，关系类型写作「可组合」或「相似」。',
].join('\n');
const lockKey = path => process.platform === 'win32' ? path.toLowerCase() : path;
const runInstructions = `先调用 skillnet_analyze 领取当前步骤。\n${instructions}`;
const stepGuide = '请按 task.guide 和 task.system 的要求完成当前步骤，并将符合 task.schema 的 JSON 对象作为 result 传给 skillnet_analyze_submit；如果未通过校验，按返回原因调整这一步后再提交。';
const unfinishedMessage = '本次图谱暂未更新。';
const malformedHint = '上一轮工具调用的参数不是合法 JSON。请检查引号、逗号和括号后，重新调用 skillnet_analyze_submit 提交当前这一步；拿到下一步后正常继续。';
const isGraphSession = id => typeof id === 'string' && /^skillnet-analysis-[0-9a-f-]{36}$/.test(id);

export function createAnalysisConversation(ctx, { root, selected, configured, hostModel, locks }) {
  const directory = join(root, 'analysis-conversations');
  const isRunning = id => id && ctx.agents?.get?.(id)?.status === 'running';
  const repairing = new WeakSet();
  ctx.systemPrompt?.context?.({
    name: 'skillnet:analysis-correction', order: 70, interpolate: false, required: true,
    text: ({ signal }) => repairing.has(signal) ? malformedHint : '',
  });
  ctx.on?.('agent/pre-step', ({ signal }, next) => {
    repairing.delete(signal);
    return next();
  });
  ctx.on?.('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (!isGraphSession(agent?.id) || signal.aborted) return next();
    if (failure.code === 'MALFORMED_RESPONSE') {
      // Native retries stay inside the same step. The next live request sees
      // the correction context without appending a synthetic user message.
      if (!repairing.has(signal)) {
        repairing.add(signal);
        return { kind: 'retry' };
      }
    } else {
      const action = await next();
      signal.throwIfAborted();
      if (action?.kind === 'retry') return action;
    }
    throw new Error(unfinishedMessage);
  });
  const path = id => {
    if (!isGraphSession(id)) throw new Error('建图对话标识无效。');
    return join(directory, `${id}.json`);
  };
  async function read(id) {
    try { return JSON.parse(await readFile(path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('这个对话没有绑定建图任务，请从技能库点击建图。'); throw error; }
  }
  async function save(record) {
    await mkdir(directory, { recursive: true });
    const target = path(record.sessionId), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, target);
  }
  async function markLatest(record) {
    const target = join(directory, `latest-${record.libraryId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ sessionId: record.sessionId }));
    await rename(temporary, target);
  }
  async function latest(item) {
    try { return JSON.parse(await readFile(join(directory, `latest-${item.id}.json`), 'utf8')).sessionId; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function syncWorkspaceTitles(libraries) {
    const names = new Map(libraries.map(item => [lockKey(item.sourcePath), item.name]));
    for (const workspace of ctx.workspaceRegistry?.list?.() ?? []) {
      const name = names.get(lockKey(workspace.path));
      if (name && workspace.title !== name && workspace.sessionIds.some(isGraphSession)) {
        await workspace.setTitle(name);
      }
    }
  }
  async function draft(args, signal) {
    const item = await selected(args);
    const running = await latest(item);
    if (isRunning(running)) return { alreadyRunning: true, sessionId: running };
    const mode = args.retrievalMode || 'model';
    if (!['model', 'vector'].includes(mode)) throw new Error('请选择仅使用模型或向量检索模式。');
    if (args.modelSource === 'sdk') throw new Error('对话建图使用 DSH 模型，请先选择 DSH 模型。');
    const host = await hostModel.capture({ signal }, args.sessionId);
    const plan = await configured({ action: 'analysis-plan', sourcePath: item.sourcePath, indexPath: item.indexPath,
      retrievalMode: mode, modelSelection: host.selection }, signal);
    signal?.throwIfAborted();
    if (plan.upToDate) return { upToDate: true, plan, message: '图谱已是最新。' };
    const sameRun = await latest(item);
    if (isRunning(sameRun)) return { alreadyRunning: true, sessionId: sameRun };
    const workspace = await ctx.workspaceRegistry.create(item.sourcePath, item.name);
    if (workspace.title !== item.name) await workspace.setTitle(item.name);
    const sessionId = `skillnet-analysis-${randomUUID()}`;
    const created = await ctx.sessionController.create({ workspaceId: workspace.id, sessionId });
    if (created.sessionId !== sessionId) throw new Error('DSH 未创建新的建图对话。');
    // Select only this new Agent; SessionController.selectModel also changes the
    // global default, which is not part of preparing a draft.
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error('新建图对话尚未就绪。');
    agent.model.select(host.selection);
    await ctx.sessionController.rename({ sessionId, title: `${item.name}建图` });
    const record = { sessionId, libraryId: item.id, sourcePath: item.sourcePath, indexPath: item.indexPath,
      retrievalMode: mode, plan, status: 'draft', createdAt: new Date().toISOString() };
    await save(record);
    await markLatest(record);
    return { sessionId, plan, prompt: `请为技能库「${item.name}」建立技能关系图。\n建图方式：${mode === 'vector' ? '向量检索（使用已配置的向量模型）' : '仅使用模型（无需向量配置）'}\n本次范围：${plan.summary}。\n\n${runInstructions}` };
  }
  async function boundLibrary(record) {
    const item = await selected({ libraryId: record.libraryId });
    if (item.sourcePath !== record.sourcePath || item.indexPath !== record.indexPath) throw new Error('技能库连接已改变，请重新点击建图。');
    return item;
  }
  function visibleStatus(record, end) {
    if (record.status === 'completed') return 'completed';
    if (isRunning(record.sessionId)) return 'running';
    if (['awaiting_result', 'needs_correction', 'running'].includes(record.status)) return 'interrupted';
    // A model response can fail before the first tool is dispatched.
    if (record.status === 'draft' && end) return 'interrupted';
    return record.status;
  }
  async function capture(record, execution) {
    const host = await hostModel.capture(execution);
    if (record.model && JSON.stringify(record.model) !== JSON.stringify(host.selection)) throw new Error('模型已改变，请恢复原模型继续，或新开建图对话。');
    return host.selection;
  }
  async function selectRun(item, record) {
    const id = await latest(item);
    if (id === record.sessionId) return;
    if (isRunning(id)) throw new Error('这个技能库正在建图。');
    await markLatest(record);
  }
  async function sendStepPrompt(record, agent, signal, prompt) {
    const item = await boundLibrary(record);
    await capture(record, { agent, signal });
    await selectRun(item, record);
    signal?.throwIfAborted();
    if (!isRunning(record.sessionId)) await agent.followup(userMessage(`${prompt}\n\n${runInstructions}`));
  }
  function summary(result) {
    const count = Object.values(result.relation_counts || {}).reduce((sum, value) => sum + value, 0);
    return `图谱已更新。分析了 ${result.skill_count} 个技能，得到 ${count} 条关系。`;
  }
  async function confirm({ agent, signal }) {
    if (!agent?.id?.startsWith('skillnet-analysis-')) return { kind: 'error', text: '请从技能库打开建图对话。' };
    const record = await read(agent.id);
    if (record.status === 'completed') return { kind: 'success', text: summary(record.result) };
    // A draft saved in the previous version may still contain /skillnet-build.
    await sendStepPrompt(record, agent, signal, '请继续为当前技能库建图，从当前步骤继续。');
    return { kind: 'success', text: '已接收建图请求。' };
  }
  async function cancel({ sessionId }) {
    await read(sessionId);
    const agent = ctx.agents?.get?.(sessionId);
    if (agent?.status === 'running') await agent.cancel('用户暂停建图');
    return status({ sessionId });
  }
  async function step(args, execution) {
    if (!execution.agent) throw new Error('请在建图对话中执行。');
    const record = await read(execution.agent.id);
    const item = await boundLibrary(record);
    const lock = lockKey(item.indexPath);
    if (locks.has(lock)) throw new Error('这个技能库正在处理另一个建图步骤，请稍后重试。');
    locks.add(lock);
    try {
      const model = await capture(record, execution);
      await selectRun(item, record);
      execution.signal?.throwIfAborted();
      let reply = await configured({ action: 'analysis-step', sourcePath: item.sourcePath, indexPath: item.indexPath,
        retrievalMode: record.retrievalMode, modelSelection: model, runPath: join(directory, record.sessionId),
        ...(args.stepId ? { stepId: args.stepId, result: args.result } : {}) }, execution.signal);
      if (reply.status === 'needs_correction') {
        const count = record.correctionStep === reply.task.stepId ? (record.correctionCount || 1) + 1 : 1;
        if (count > 2) {
          execution.concludeTurn?.();
          reply = { status: 'failed', message: unfinishedMessage, progress: reply.progress };
          delete record.correctionStep;
          delete record.correctionCount;
        } else {
          record.correctionStep = reply.task.stepId;
          record.correctionCount = count;
        }
      } else if (record.correctionStep !== reply.task?.stepId) {
        delete record.correctionStep;
        delete record.correctionCount;
      }
      Object.assign(record, { model, status: reply.status, progress: reply.progress, result: reply.result, updatedAt: new Date().toISOString() });
      delete record.error;
      await save(record);
      return !args.stepId || reply.status === 'needs_correction' ? { ...reply, guide: stepGuide } : reply;
    } finally { locks.delete(lock); }
  }
  async function status(args) {
    let id = args.sessionId;
    if (!id) id = await latest(await selected(args));
    if (!id) return null;
    const record = await read(id);
    const end = !isRunning(id) && record.status !== 'completed'
      ? ctx.agents?.get?.(id)?.session?.snapshotEvents?.().findLast(event => event.type === 'turn/end')?.data?.reason
      : undefined;
    const phase = visibleStatus(record, end);
    return { sessionId: record.sessionId, sourcePath: record.sourcePath, status: phase,
      cancellable: phase === 'running',
      message: phase === 'completed' && record.result ? summary(record.result)
        : phase === 'interrupted' || phase === 'failed' || phase === 'killed'
          ? end?.kind === 'aborted' || phase === 'killed' ? '建图已暂停。' : unfinishedMessage
          : undefined,
      plan: record.plan, progress: record.progress, result: record.result };
  }
  // Restrict only dedicated graph conversations, including those reopened after
  // restart. Other user conversations retain their native tools unchanged.
  ctx.tools?.guard?.(execution => {
    const id = execution.agent?.id;
    if (!id?.startsWith('skillnet-analysis-')) return;
    if (!['skillnet_analyze', 'skillnet_analyze_submit'].includes(execution.name)) return '当前建图对话只使用 skillnet_analyze 和 skillnet_analyze_submit，技能源码和规范会随步骤直接返回。';
  });
  return { draft, step, status, confirm, cancel, syncWorkspaceTitles };
}
