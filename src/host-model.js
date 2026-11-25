import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const textBlocks = message => (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const plain = value => String(value).replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer [已隐藏]').replace(/\bsk-[\w-]+/g, '[已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[已隐藏]');
// DSH inboxes accept complete, identified messages, not bare content payloads.
export const userMessage = text => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

export function createHostModel(ctx) {
  const owned = new Set();
  async function contexts(signal) {
    let items = [];
    const controller = ctx.get?.('sessionController');
    if (controller) { try { items = (await controller.list({}, signal)).items; } catch {} }
    const live = ctx.agents.list().filter(agent => !owned.has(agent.id) && agent.session?.header.origin !== 'subagent');
    const titles = ctx.get?.('sessionTitle');
    const sessions = live.map(agent => {
      const item = items.find(item => item.sessionId === agent.id);
      // The sidebar reads the "title" projection, not a top-level list field.
      const title = item?.projections?.values?.title || titles?.get(agent.session)?.title || item?.title || basename(item?.cwd || agent.session?.header.cwd || '') || '未命名对话';
      return { sessionId: agent.id, title, selection: agent.model.current() };
    });
    return { default: ctx.agentDefaultModel.currentSelection() || null, sessions: sessions.filter(item => !owned.has(item.sessionId) && !item.sessionId.startsWith('skillnet-model-')) };
  }
  async function agentFor(sessionId, signal) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('skillnet-model-')) throw new Error('请先选择要使用的 DSH 对话。');
    signal?.throwIfAborted();
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error('请先在 DSH 打开目标对话，然后刷新对话列表。');
    if (owned.has(agent.id) || agent.session?.header.origin === 'subagent') throw new Error('请选择用户对话，不能选择内部模型作业。');
    return agent;
  }
  async function capture(execution = {}, sessionId) {
    const parent = execution.agent || (sessionId ? await agentFor(sessionId, execution.signal) : null);
    const selection = parent?.model.current() || ctx.agentDefaultModel.currentSelection();
    if (!selection?.provider || !selection?.model) throw new Error('请先在 DSH 选择可用模型，或在面板选择已有对话。');
    return { selection: { ...selection }, sessionId: parent?.id || null };
  }
  async function reasoningEfforts(model, signal) {
    const { selection } = model;
    signal?.throwIfAborted();
    let info;
    try {
      info = await ctx.llm?.resolveModelInfo?.(selection.provider, selection.model, signal);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
    signal?.throwIfAborted();
    return info?.reasoning?.efforts?.map(effort => effort.id) ?? [];
  }
  async function forRelationReview(model, signal) {
    const offered = await reasoningEfforts(model, signal);
    const reasoningEffort = ['low', 'off'].find(level => offered.includes(level));
    return reasoningEffort ? { ...model, selection: { ...model.selection, reasoningEffort } } : model;
  }
  async function conversation(sessionId, signal) {
    const agent = await agentFor(sessionId, signal);
    const messages = ctx.sessions.get(agent.id).deriveMessages().filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({ role: message.role, text: textBlocks(message) })).filter(message => message.text);
    const chosen = messages.slice(-24);
    return { content: plain(chosen.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n')).slice(-80_000), count: chosen.length, limited: chosen.length < messages.length };
  }
  async function invoke(model, request, signal, onSession) {
    const callerSignal = signal;
    const deadline = request.timeout_ms ? AbortSignal.timeout(request.timeout_ms) : null;
    if (deadline) signal = AbortSignal.any([...(signal ? [signal] : []), deadline]);
    const failure = error => {
      if (!deadline?.aborted || callerSignal?.aborted) return error;
      const label = request.label ? `${plain(request.label)}：` : '';
      const timeout = new Error(`${label}DSH 模型调用超时（${request.timeout_ms / 1000} 秒），已停止本次调用。`, { cause: error });
      timeout.name = 'TimeoutError';
      return timeout;
    };
    signal?.throwIfAborted();
    const sessionId = `skillnet-model-${randomUUID()}`;
    let steps = 0, reads = 0, listings = 0;
    const wiki = request.method === 'explore' ? await realpath(request.root) : null;
    owned.add(sessionId);
    const allowed = wiki ? ['read_wiki', 'list_wiki'] : [];
    const handle = await ctx.agents.create({ sessionId, signal, agentOptions: { ...model.selection },
      meta: { cwd: wiki || process.cwd(), origin: 'subagent', ...(model.sessionId ? { parentSession: model.sessionId } : {}) },
      setup(scope) {
        scope.systemPrompt.section({ name: 'skillnet:operation', order: 0, complete: true, interpolate: false, text: request.system + '\n用户可见的说明与选择理由默认使用简体中文。保留协议字段、技能标识和文件路径。' });
        scope.tools.restrict({ allow: [] });
        scope.tools.guard(exec => allowed.includes(exec.name) ? undefined : '此任务只允许读取候选 Wiki。');
        scope.on('agent/pre-step', (_event, next) => { signal?.throwIfAborted(); if (++steps > Math.min(24, request.max_turns || (wiki ? 24 : 1))) throw new Error('模型作业超过步骤预算。'); return next(); });
        if (wiki) for (const name of allowed) scope.tools.register({ name, description: name === 'read_wiki' ? '读取候选 Wiki 文件，路径必须相对于 Wiki 根目录。' : '列出候选 Wiki 目录，根目录使用路径 "."。',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute(args, execution) {
            execution.signal.throwIfAborted();
            if (typeof args.path !== 'string' || isAbsolute(args.path)) throw new Error('请使用 Wiki 相对路径。');
            const target = await realpath(join(wiki, args.path));
            const rel = relative(wiki, target);
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('不能访问候选 Wiki 以外的文件。');
            if (name === 'read_wiki') {
              if (++reads > Math.min(42, request.read_limit || 12)) throw new Error('超过 Wiki 读取预算。');
              const info = await stat(target);
              if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Wiki 文件不可读取或超过大小限制。');
              return readFile(target, { encoding: 'utf8', signal: execution.signal });
            }
            if (++listings > 3) throw new Error('超过 Wiki 目录查看预算。');
            return (await readdir(target, { withFileTypes: true })).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).join('\n');
          },
        });
      },
    }).catch(error => { owned.delete(sessionId); throw failure(error); });
    const cancel = () => handle.agent.cancel('SkillNet 作业已取消');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      await onSession?.(sessionId);
      signal?.throwIfAborted();
      await handle.agent.followup(userMessage(request.prompt));
      if (signal?.aborted) { await cancel(); signal.throwIfAborted(); }
      await handle.agent.whenIdle();
      signal?.throwIfAborted();
      const session = ctx.sessions.get(sessionId);
      const events = session.snapshotEvents();
      const ending = events.findLast(event => event.type === 'turn/end');
      const last = events.findLast(event => event.type === 'assistant/message');
      const reason = ending?.data.reason;
      const finish = last?.data.stream?.map(event => event.type === 'chunk' ? event.chunk : event).findLast(event => event?.type === 'finish');
      if (reason?.kind === 'error') {
        const failure = reason.error || reason.failure || {};
        const code = failure.code ? `（${plain(failure.code)}）` : '';
        throw new Error(`DSH 模型 ${plain(model.selection.model)} 调用失败${code}：${plain(failure.message || '未收到模型回复。').slice(0, 2000)}`);
      }
      if (reason?.kind === 'max-tokens' || ['max-tokens', 'length'].includes(finish?.reason?.kind)) {
        if (request.format === 'relation-lines' && last) return { content: textBlocks(last.data.message), truncated: true, sessionId };
        if (request.expect_json) return { content: '', truncated: true, sessionId };
        throw new Error('DSH 模型输出达到长度上限，结果被截断，请调整所选模型的输出上限后重试。');
      }
      if (finish?.reason && finish.reason.kind !== 'stop') throw new Error(`DSH 模型输出未完整结束（${plain(finish.reason.kind)}）。`);
      if (!ending || reason?.kind !== 'completed' || last?.data.interrupted || (!last && !request.expect_json)) throw new Error(`DSH 模型任务已中断，未获得完整结果（${plain(reason?.kind || '缺少结束事件')}${!last ? '，没有助手回复' : last.data.interrupted ? '，回复被中断' : ''}）。`);
      const content = last ? textBlocks(last.data.message) : '';
      if (!content.trim() && !request.expect_json) throw new Error('DSH 模型没有返回文本结果。');
      return { content, sessionId };
    } catch (error) {
      throw failure(error);
    } finally {
      signal?.removeEventListener('abort', cancel);
      try { await handle.dispose(); } finally { owned.delete(sessionId); }
    }
  }
  async function use(selection, sessionId, signal) {
    const agent = await agentFor(sessionId, signal);
    const prompt = '请先通过原生 skill 工具加载以下已选技能，再处理这项任务。选择理由供参考，执行时遵守技能约束。\n' + JSON.stringify(selection, null, 2);
    await agent.followup(userMessage(prompt));
    return { sessionId: agent.id, accepted: true };
  }
  return { contexts, capture, reasoningEfforts, forRelationReview, invoke, conversation, agentFor, use };
}
