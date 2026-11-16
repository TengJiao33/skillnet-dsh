import React, { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, ListChecks, Share2 } from 'lucide-react'
import App from './upstream/src/App'
import type { WorkbenchContext } from './upstream/src/App'
import { api } from './api'
import { Select } from './Select'
import { ModelChoice, TaskList } from './operations'
import type { ModelTarget } from './operations'
import type { SkillDraft, AnalysisDraft } from './chatDraft'

type UseSelection = { sourcePath: string, skillId: string, names: string[] }

function UseSkillDialog({ selection, onClose, onUseSkill }: { selection: UseSelection, onClose: () => void, onUseSkill: (selection: SkillDraft) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const refresh = async (signal?: AbortSignal) => {
    setLoading(true); setError('')
    try {
      const contexts = await api('model-context', {}, signal)
      if (signal?.aborted) return
      setSessions(contexts.sessions)
      setSessionId(value => contexts.sessions.some((item: any) => item.sessionId === value) ? value : '')
    } catch (e: any) { if (!signal?.aborted) setError(e.message) }
    finally { if (!signal?.aborted) setLoading(false) }
  }
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort(); if (element?.open) element.close() }
  }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || !sessionId) return
    pending.current = true; setBusy(true); setError(''); setPreview(null)
    try {
      const value = await api('skill-draft', { sourcePath: selection.sourcePath, skillId: selection.skillId, sessionId })
      if (!value.ready) { setPreview(value.preview || null); setError(value.message || '暂时无法添加这个技能。'); return }
      onUseSkill(value)
      onClose()
    } catch (e: any) { setError(e.message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <dialog className="dsh-use-dialog" ref={dialog} aria-labelledby="dsh-use-heading" onClose={onClose} onCancel={event => { if (pending.current) event.preventDefault() }}>
    <form onSubmit={event => void submit(event)}>
      <header className="dsh-row"><h2 id="dsh-use-heading">添加技能到对话</h2><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>关闭</button></header>
      <h3 className="dsh-use-skills">{selection.names.join('、')}</h3>
      <label className="dsh-destination"><span>目标对话</span><Select aria-label="目标对话" value={sessionId} disabled={loading || busy} onValueChange={setSessionId}>
        <option value="" disabled>{loading ? '正在读取对话…' : '请选择已打开的对话'}</option>
        {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}
      </Select></label>
      {!loading && !sessions.length && <p role="status">请先在 DSH 新建或打开一个对话。</p>}
      <p>保留对话中已有的输入，添加技能后可继续编辑再发送。</p>
      {error && <p role="alert">{error}</p>}
      {preview && <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('skillnet-preview', { detail: preview })); dialog.current?.close() }}>预览并安装</button>}
      <footer className="dsh-row"><button type="submit" disabled={!sessionId || loading || busy}>{busy ? '正在添加…' : '添加到对话'}</button></footer>
    </form>
  </dialog>
}

const jobKey = (context: WorkbenchContext, action: string) => JSON.stringify([context.library?.sourcePath, action, action === 'evaluate' ? context.selectedSkill?.id : ''])

function ModelOperationDialog({ context, target, disabled, onClose, onConfirm }: { context: WorkbenchContext, target: ModelTarget, disabled: boolean, onClose: () => void, onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef(false)
  const [model, setModel] = useState(target.modelSource === 'sdk' ? '独立 API（高级）' : target.sessionId ? '所选 DSH 对话的模型' : 'DSH 默认模型')
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    const controller = new AbortController()
    if (target.modelSource !== 'sdk') void api('model-context', {}, controller.signal).then(contexts => {
      if (controller.signal.aborted) return
      const session = target.sessionId ? contexts.sessions.find((item: any) => item.sessionId === target.sessionId) : null
      const selection = target.sessionId ? session?.selection : contexts.default
      const source = target.sessionId ? session?.title || '所选 DSH 对话' : 'DSH 默认模型'
      setModel(selection?.model ? `${source} / ${selection.model}` : source)
    }).catch(() => {})
    return () => { controller.abort(); if (element?.open) element.close() }
  }, [target.modelSource, target.sessionId])
  return <dialog className="dsh-use-dialog dsh-graph-dialog dsh-evaluate-dialog" ref={dialog} aria-labelledby="dsh-graph-heading" aria-describedby="dsh-graph-description" onClose={onClose}>
    <div className="dsh-graph-confirm">
      <h2 id="dsh-graph-heading">确认评估技能</h2>
      <p id="dsh-graph-description">将评估技能 <strong>{context.selectedSkill?.name}</strong> 的安全性、完整性、可执行性、可维护性和成本意识。</p>
      <dl className="dsh-graph-summary">
        <div><dt>使用模型</dt><dd>{model}</dd></div>
      </dl>
      <p className="dsh-graph-note">此操作会调用模型，可能需要一些时间。</p>
      <footer className="dsh-row">
        <button type="button" autoFocus onClick={onClose}>取消</button>
        <button type="button" className="dsh-workbench-action dsh-graph-action" disabled={disabled} onClick={() => { if (pending.current) return; pending.current = true; onConfirm() }}>开始评估</button>
      </footer>
    </div>
  </dialog>
}

function AnalysisProgress({ context, active, onOpen }: { context: WorkbenchContext, active: boolean, onOpen: (sessionId: string) => void }) {
  const [state, setState] = useState<any>(null)
  const completed = useRef('')
  const refresh = useRef(context.refresh)
  refresh.current = context.refresh
  useEffect(() => {
    if (!active || !context.library) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api('analysis-status', { sourcePath: context.library!.sourcePath }, controller.signal)
        if (controller.signal.aborted) return
        setState(next)
        if (next?.status === 'completed' && completed.current !== next.sessionId) { completed.current = next.sessionId; refresh.current() }
      } catch { /* A temporarily unavailable host does not erase the graph. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, context.library?.sourcePath])
  if (!state || state.status === 'completed') return null
  return <div className="dsh-row dsh-context-result" role="status">
    <span>{state.status === 'draft' ? '建图草稿已准备，发送后开始。' : `已校验 ${state.progress?.profiles || 0}/${state.progress?.skills || 0} 项画像${state.progress?.candidates != null ? `、${state.progress.relations}/${state.progress.candidates} 对关系` : ''}；可在对话中继续。`}</span>
    <button type="button" onClick={() => onOpen(state.sessionId)}>打开建图对话</button>
  </div>
}

export function LibraryWorkbench({ logo, headerActions, active, target, onTarget, onUseSkill, onAnalyze, onOpenAnalysis }: { logo: string, headerActions: ReactNode, active: boolean, target: ModelTarget, onTarget: (value: ModelTarget) => void, onUseSkill: (selection: SkillDraft) => void, onAnalyze: (draft: AnalysisDraft) => void, onOpenAnalysis: (sessionId: string) => void }) {
  const [retrievalMode, setRetrievalMode] = useState<'model' | 'vector'>('model')
  const [latest, setLatest] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const starting = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [modelsOpen, setModelsOpen] = useState(false)
  const [useSelection, setUseSelection] = useState<UseSelection | null>(null)
  const [confirmation, setConfirmation] = useState<{ context: WorkbenchContext, action: 'evaluate' } | null>(null)
  async function start(context: WorkbenchContext, action: 'analyze' | 'evaluate') {
    if (!context.library) return
    const key = jobKey(context, action)
    if (starting.current.has(key)) return
    starting.current.add(key); setBusy(value => ({ ...value, [key]: true })); setErrors(value => ({ ...value, [key]: '' }))
    try {
      if (action === 'analyze') {
        const draft = await api('analysis-draft', { ...target, sourcePath: context.library.sourcePath, retrievalMode })
        onAnalyze(draft)
        return
      }
      const task = await api('start', { ...target, action, sourcePath: context.library.sourcePath,
        skillId: context.selectedSkill?.id })
      setLatest(value => ({ ...value, [key]: task.id }))
      setRunning(value => ({ ...value, [key]: true }))
    } catch (e: any) { setErrors(value => ({ ...value, [key]: e.message })) }
    finally { starting.current.delete(key); setBusy(value => ({ ...value, [key]: false })) }
  }
  const tasks = (context: WorkbenchContext, action: string) => {
    const key = jobKey(context, action)
    return <div className={`dsh-context-result dsh-${action}-context`}>
      {errors[key] && <p className="error-banner" role="alert">{errors[key]}</p>}
      <TaskList key={key} revision={0} latestTaskId={latest[key]} sourcePath={context.library?.sourcePath} onlyAction={action} skillId={action === 'evaluate' ? context.selectedSkill?.id : undefined} enabled={active} compact
        onPick={context.selectSkill}
        onRunningChange={active => setRunning(value => value[key] === active ? value : { ...value, [key]: active })}
        onComplete={() => { setErrors(value => ({ ...value, [key]: '' })); if (action === 'analyze') context.refresh() }} />
    </div>
  }
  return <>
    <App compactControls logoUrl={logo} headerActions={headerActions}
      renderOptions={context => context.library && <details className="dsh-workbench-tools" onToggle={event => setModelsOpen(event.currentTarget.open)}>
        <summary>模型</summary><div className="dsh-tools-body">
          {modelsOpen && <ModelChoice value={target} onChange={onTarget} />}
          <label className="collection-control"><span>建图模式</span><Select aria-label="建图模式" value={retrievalMode} onValueChange={value => setRetrievalMode(value as 'model' | 'vector')}>
            <option value="model">仅使用模型（默认）</option><option value="vector">向量检索（可选）</option>
          </Select></label>
          <p>{retrievalMode === 'vector' ? '需要配置向量模型，并用此模式建图。' : '使用所选 DSH 模型建图，无需向量配置。'}</p>
        </div>
      </details>}
      renderGraphActions={context => context.library && <button type="button" className="dsh-workbench-action dsh-graph-action" title="打开新对话，发送草稿后开始" disabled={busy[jobKey(context, 'analyze')] || !context.localData?.source.skills.length} onClick={() => void start(context, 'analyze')}><Share2 size={18} strokeWidth={1.8} aria-hidden="true" />{busy[jobKey(context, 'analyze')] ? '正在打开…' : context.localData?.analysis ? '更新图谱' : '建图'}</button>}
      renderGraphResult={context => context.library && <>{errors[jobKey(context, 'analyze')] && <p className="error-banner" role="alert">{errors[jobKey(context, 'analyze')]}</p>}<AnalysisProgress context={context} active={active} onOpen={onOpenAnalysis} /></>}
      renderSkillActions={context => context.library && context.selectedSkill && <div className="dsh-skill-actions" role="group" aria-label="当前技能操作">
        <button className="dsh-workbench-action" aria-label="使用此技能" title="在 DSH 对话中使用" disabled={!context.localData?.source.skills.some(skill => skill.id === context.selectedSkill!.id)} onClick={() => setUseSelection({ sourcePath: context.library!.sourcePath, skillId: context.selectedSkill!.id, names: [context.selectedSkill!.name] })}><ArrowUpRight size={18} strokeWidth={1.8} aria-hidden="true" />使用</button>
      </div>}
      renderSkillResult={context => context.library && context.selectedSkill && <section className="inspector-section skill-quality-section" aria-label="质量评估">
        <div className="section-heading"><h3 className="skill-section-label">质量评估</h3>
          <button type="button" className="dsh-workbench-action quality-action" aria-label="评估技能" aria-haspopup="dialog" title="检查当前技能的质量" disabled={busy[jobKey(context, 'evaluate')] || running[jobKey(context, 'evaluate')] || !context.localData?.source.skills.some(skill => skill.id === context.selectedSkill!.id)} onClick={() => setConfirmation({ context, action: 'evaluate' })}><ListChecks size={16} strokeWidth={1.8} aria-hidden="true" />评估</button>
        </div>
        {tasks(context, 'evaluate')}
      </section>}
    />
    {confirmation && <ModelOperationDialog context={confirmation.context} target={target} disabled={Boolean(busy[jobKey(confirmation.context, confirmation.action)] || running[jobKey(confirmation.context, confirmation.action)])} onClose={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); void start(confirmation.context, confirmation.action) }} />}
    {useSelection && <UseSkillDialog selection={useSelection} onClose={() => setUseSelection(null)} onUseSkill={onUseSkill} />}
  </>
}
