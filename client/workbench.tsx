import React, { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, ListChecks, Share2, X } from 'lucide-react'
import App from './upstream/src/App'
import type { WorkbenchContext } from './upstream/src/App'
import { api } from './api'
import { Select } from './Select'
import { ModelChoice, TaskList } from './operations'
import type { ModelTarget } from './operations'
import type { RouteDraft, SkillDraft, SkillDraftTarget } from './chatDraft'
import { useInstallationManagement, RemoveInstalledSkill, RemovedInstallations, InstallationManagementDialog, TrackInstalledSkillUpdate } from './installationManagement'

type UseSelection = { kind: 'skill', sourcePath: string, skillId: string, libraryName: string, name: string } |
  { kind: 'route', id: string, names: string[], pickSkill: (id: string) => void }
type DraftBlock = { actualPath?: string, skillId?: string, preview?: any }
type SkillAvailability = { status: 'available' | 'unavailable', actualPath?: string, message?: string, modelInvocable: boolean, userInvocable: boolean }

function ConversationDraftDialog({ selection, onClose, onUseSkill, onRouteDraft }: { selection: UseSelection, onClose: () => void, onUseSkill: (selection: SkillDraft) => void, onRouteDraft: (selection: RouteDraft) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState<DraftBlock | null>(null)
  const [availability, setAvailability] = useState<SkillAvailability | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [availabilityError, setAvailabilityError] = useState('')
  const isRoute = selection.kind === 'route'
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
  useEffect(() => {
    if (selection.kind !== 'skill' || !sessionId) return
    const controller = new AbortController()
    setCheckingStatus(true); setAvailability(null); setAvailabilityError('')
    void api('skill-status', { sourcePath: selection.sourcePath, skillId: selection.skillId, sessionId }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setAvailability(value) })
      .catch(cause => { if (!controller.signal.aborted) setAvailabilityError(cause.message) })
      .finally(() => { if (!controller.signal.aborted) setCheckingStatus(false) })
    return () => controller.abort()
  }, [selection, sessionId])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || !sessionId) return
    pending.current = true; setBusy(true); setError(''); setBlocked(null)
    try {
      const value = selection.kind === 'route'
        ? await api('route-draft', { id: selection.id, sessionId, preview: false })
        : await api('skill-draft', { sourcePath: selection.sourcePath, skillId: selection.skillId, sessionId })
      if (!value.ready) { setBlocked(value); setError(value.message || '暂时无法添加到目标对话。'); return }
      if (selection.kind === 'route') onRouteDraft(value)
      else onUseSkill(value)
      onClose()
    } catch (e: any) { setError(e.message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <dialog className="dsh-use-dialog" ref={dialog} aria-labelledby="dsh-use-heading" onClose={onClose} onCancel={event => { if (pending.current) event.preventDefault() }}>
    <form onSubmit={event => void submit(event)}>
      <header className="dsh-row"><h2 id="dsh-use-heading">{isRoute ? '添加任务到对话草稿' : '添加技能到对话'}</h2><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>关闭</button></header>
      <h3 className="dsh-use-skills">{selection.kind === 'route' ? selection.names.join('、') : selection.name}</h3>
      <label className="dsh-destination"><span>目标对话</span><Select aria-label="目标对话" value={sessionId} disabled={loading || busy} onValueChange={id => { setSessionId(id); setBlocked(null); setError('') }}>
        <option value="" disabled>{loading ? '正在读取对话…' : '请选择已打开的对话'}</option>
        {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}
      </Select></label>
      {!loading && !sessions.length && <p role="status">请先在 DSH 新建或打开一个对话。</p>}
      <p>{isRoute ? '把原任务和推荐技能追加到已有输入，编辑后由你发送。' : '保留对话中已有的输入，添加技能后可继续编辑再发送。'}</p>
      {!error && !isRoute && sessionId && <>
        {checkingStatus && <p role="status">正在检查对话可用性…</p>}
        {availabilityError && <p role="alert">{availabilityError}</p>}
        {availability?.status === 'available' && <p role="status">添加到草稿{availability.userInvocable ? '可用' : '受限'} · 助手直接调用{availability.modelInvocable ? '可用' : '受限'}</p>}
        {availability?.status === 'unavailable' && <>
          <p role="status">{availability.message || '此技能在目标对话中不可用。'}</p>
          {availability.actualPath && <p className="dsh-path">当前生效路径 <code>{availability.actualPath}</code></p>}
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
      {blocked?.actualPath && <p className="dsh-path">当前生效路径 <code>{blocked.actualPath}</code></p>}
      {selection.kind === 'route' && blocked?.skillId && <button type="button" onClick={() => { selection.pickSkill(blocked.skillId!); onClose() }}>查看受阻技能</button>}
      {selection.kind === 'skill' && blocked?.preview && <button type="button" onClick={() => {
        const conversation: SkillDraftTarget = { sourcePath: selection.sourcePath, skillId: selection.skillId, libraryName: selection.libraryName, sessionId, sessionTitle: sessions.find(item => item.sessionId === sessionId)?.title || '目标对话' }
        window.dispatchEvent(new CustomEvent('skillnet-preview', { detail: { ...blocked.preview, conversation } }))
        dialog.current?.close()
      }}>预览并安装到个人技能库</button>}
      <footer className="dsh-row"><button type="submit" disabled={!sessionId || loading || busy}>{busy ? '正在添加…' : isRoute ? '添加到对话草稿' : '添加到对话'}</button></footer>
    </form>
  </dialog>
}

type WorkbenchAction = 'analyze' | 'evaluate' | 'route' | 'evaluate-batch'
const jobKey = (context: WorkbenchContext, action: WorkbenchAction) => JSON.stringify([context.library?.sourcePath, action, action === 'evaluate' ? context.selectedSkill?.id : ''])

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

function GraphAction({ context, busy, running, onStart }: {
  context: WorkbenchContext, busy: boolean, running: boolean, onStart: () => void
}) {
  return <button type="button" className="dsh-workbench-action dsh-graph-action"
    title="检查技能库并启动后台建图"
    disabled={busy || running || !context.localData?.source.skills.length} onClick={onStart}>
    <Share2 size={18} strokeWidth={1.8} aria-hidden="true" />
    {busy ? '正在检查…' : running ? '建图中' : context.localData?.analysis ? '更新图谱' : '建图'}
  </button>
}

function LibraryTaskDialog({ heading, libraryName, onClose, children, open = true }: { heading: string, libraryName: string, onClose: () => void, children: ReactNode, open?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    if (!open) return
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [open])
  function close() {
    dialog.current?.close()
    onClose()
  }
  return <dialog className="dsh-use-dialog dsh-matching-dialog" ref={dialog} aria-labelledby={headingId} onClose={onClose}
    onCancel={event => { event.preventDefault(); close() }}>
    <header className="dsh-row dsh-matching-heading">
      <h2 id={headingId}>{heading}</h2>
      <button type="button" aria-label={`关闭${heading}`} onClick={close}><X size={18} aria-hidden="true" /></button>
    </header>
    <p>技能库「{libraryName}」</p>
    {children}
  </dialog>
}

export function LibraryWorkbench({ logo, headerActions, active, target, onTarget, onUseSkill, onRouteDraft }: { logo: string, headerActions: ReactNode, active: boolean, target: ModelTarget, onTarget: (value: ModelTarget) => void, onUseSkill: (selection: SkillDraft) => void, onRouteDraft: (selection: RouteDraft) => void }) {
  const [retrievalMode, setRetrievalMode] = useState<'auto' | 'model' | 'vector'>('auto')
  const [latest, setLatest] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const starting = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [openGraph, setOpenGraph] = useState<string | null>(null)
  const [graphNotice, setGraphNotice] = useState<{ key: string, text: string } | null>(null)
  const graphNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const startedGraphs = useRef(new Set<string>())
  const [modelsOpen, setModelsOpen] = useState(false)
  const [matchingOpen, setMatchingOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchMode, setBatchMode] = useState<'missing' | 'all'>('missing')
  const [useSelection, setUseSelection] = useState<UseSelection | null>(null)
  const [confirmation, setConfirmation] = useState<{ context: WorkbenchContext, action: 'evaluate' } | null>(null)
  const [queries, setQueries] = useState<Record<string, string>>({})
  const installations = useInstallationManagement(active)
  useEffect(() => () => clearTimeout(graphNoticeTimer.current), [])
  function announceGraph(key: string, text: string) {
    clearTimeout(graphNoticeTimer.current)
    setGraphNotice({ key, text })
    graphNoticeTimer.current = setTimeout(() => setGraphNotice(null), 3500)
  }
  async function start(context: WorkbenchContext, action: WorkbenchAction, { retryTaskId, query }: { retryTaskId?: string, query?: string } = {}) {
    if (!context.library || (action === 'route' && !query)) return
    const key = jobKey(context, action)
    if (starting.current.has(key) || running[key]) return
    starting.current.add(key); setBusy(value => ({ ...value, [key]: true })); setErrors(value => ({ ...value, [key]: '' })); setNotices(value => ({ ...value, [key]: '' }))
    try {
      const libraryId = context.library.id.replace(/^local:/, '')
      const input = action === 'route' ? { libraryId, query, retrievalMode: 'auto' }
        : action === 'evaluate-batch' ? { libraryId, ...(retryTaskId ? { retryTaskId } : {
          batchMode, sessionId: target.sessionId, modelSource: target.modelSource === 'sdk' ? 'sdk' : 'host',
        }) }
        : { sourcePath: context.library.sourcePath, ...(action === 'analyze' ? { retrievalMode, retryTaskId } : { skillId: context.selectedSkill?.id }) }
      const task = await api('start', { ...(action === 'evaluate-batch' ? {} : target), action, ...input })
      if (task.upToDate) {
        if (action === 'analyze') announceGraph(key, task.message || '图谱已是最新。')
        else setNotices(value => ({ ...value, [key]: task.message }))
        return
      }
      if (action === 'analyze') startedGraphs.current.add(task.id)
      setLatest(value => ({ ...value, [key]: task.id }))
      setRunning(value => ({ ...value, [key]: true }))
    } catch (e: any) {
      setErrors(value => ({ ...value, [key]: e.message }))
      if (action === 'analyze') announceGraph(key, '无法启动建图。详情见建图记录。')
    }
    finally { starting.current.delete(key); setBusy(value => ({ ...value, [key]: false })) }
  }
  const tasks = (context: WorkbenchContext, action: WorkbenchAction) => {
    const key = jobKey(context, action)
    const pickSkill = (id: string) => {
      if (action === 'route') setMatchingOpen(false)
      if (action === 'evaluate-batch') setBatchOpen(false)
      context.selectSkill(id)
    }
    return <div className={`dsh-context-result dsh-${action}-context`}>
      {errors[key] && <p className="error-banner" role="alert">{errors[key]}</p>}
      <TaskList key={key} revision={0} latestTaskId={latest[key]} sourcePath={context.library?.sourcePath} onlyAction={action} skillId={action === 'evaluate' ? context.selectedSkill?.id : undefined} enabled={active} compact
        showHistory={action === 'analyze'}
        onPick={pickSkill}
        onUse={action === 'route' ? task => setUseSelection({ kind: 'route', id: task.id, names: task.result.skills.map((skill: { name: string }) => skill.name), pickSkill }) : undefined}
        onViewGraph={() => { if (action === 'analyze') setOpenGraph(null); context.showGraph() }}
        onRetryProfiles={() => void start(context, 'analyze')}
        onRetryRelations={id => void start(context, 'analyze', { retryTaskId: id })}
        onRetryBatch={id => void start(context, 'evaluate-batch', { retryTaskId: id })}
        retryDisabled={!!busy[key] || !!running[key]}
        onRunningChange={active => setRunning(value => value[key] === active ? value : { ...value, [key]: active })}
        onSettled={(task, wasRunning) => {
          if (action !== 'analyze') return
          const startedHere = startedGraphs.current.delete(task.id)
          if (!wasRunning && !startedHere) return
          if (task.status === 'completed') { context.refresh(); announceGraph(key, '图谱已更新。') }
          else if (task.status === 'killed') announceGraph(key, '建图已取消。')
          else if (task.status === 'failed') announceGraph(key, '建图失败。详情见建图记录。')
        }} />
    </div>
  }
  return <>
    <App compactControls logoUrl={logo} headerActions={headerActions}
      renderLibraryManagement={(closeMenu, context) => <>
        {context.library && <button type="button" aria-haspopup="dialog" onClick={() => { closeMenu(); setBatchOpen(true) }}>批量评估</button>}
        <RemovedInstallations management={installations} onOpen={closeMenu} />
      </>}
      renderOptions={context => {
        if (!context.library) return null
        const key = jobKey(context, 'route')
        const query = queries[key] || ''
        const matching = busy[key] || running[key]
        const batchKey = jobKey(context, 'evaluate-batch')
        const evaluating = busy[batchKey] || running[batchKey]
        const ready = Boolean(context.localData?.source.skills.length)
        return <>
          <details className="dsh-workbench-tools" onToggle={event => setModelsOpen(event.currentTarget.open)}>
            <summary>模型</summary><div className="dsh-tools-body">
              <div className="dsh-tools-model-row">
                {modelsOpen && <ModelChoice value={target} onChange={onTarget} showRefresh={false} />}
                <button type="button" className="dsh-workbench-action dsh-tools-close" aria-label="关闭模型设置" title="关闭模型设置" onClick={event => {
                  const panel = event.currentTarget.closest('details')
                  if (!panel) return
                  panel.open = false
                  panel.querySelector('summary')?.focus()
                }}><X size={18} aria-hidden="true" /></button>
              </div>
              <label className="collection-control"><span>建图模式</span><Select aria-label="建图模式" value={retrievalMode} onValueChange={value => setRetrievalMode(value as typeof retrievalMode)}>
                <option value="auto">自动（优先向量）</option><option value="model">仅使用模型</option><option value="vector">向量检索</option>
              </Select></label>
              <p>{retrievalMode === 'auto' ? '配置向量模型后使用 SkillNet SDK 建图。' : retrievalMode === 'vector' ? '需要配置向量模型。' : '使用所选 DSH 模型和本地关键词筛选。'}</p>
            </div>
          </details>
          <button type="button" className="dsh-workbench-action" aria-haspopup="dialog" onClick={() => setMatchingOpen(true)}>任务匹配</button>
          {matchingOpen && active && <LibraryTaskDialog heading="任务匹配" libraryName={context.library.name} onClose={() => setMatchingOpen(false)}>
            <form className="dsh-matchbar" aria-label="任务匹配" onSubmit={event => { event.preventDefault(); if (ready) void start(context, 'route', { query: query.trim() }) }}>
              <label className="dsh-route-query"><span>任务</span><input autoFocus value={query} disabled={!ready || matching} onChange={event => setQueries(value => ({ ...value, [key]: event.target.value }))} placeholder="描述希望完成的任务" required /></label>
              <button className="primary-button" type="submit" disabled={!ready || matching || !query.trim()}>{matching ? '匹配中…' : '匹配技能'}</button>
            </form>
            {tasks(context, 'route')}
          </LibraryTaskDialog>}
          {batchOpen && active && <LibraryTaskDialog heading="批量评估" libraryName={context.library.name} onClose={() => setBatchOpen(false)}>
            <form onSubmit={event => { event.preventDefault(); if (ready) void start(context, 'evaluate-batch') }}>
              <fieldset disabled={evaluating || !ready} className="dsh-batch-options">
                <label className="collection-control"><span>评估范围</span><Select aria-label="评估范围" value={batchMode} disabled={evaluating || !ready} onValueChange={value => setBatchMode(value as typeof batchMode)}>
                  <option value="missing">仅评估本版未覆盖的技能</option><option value="all">重新评估全部技能</option>
                </Select></label>
                <ModelChoice value={target} onChange={onTarget} showRefresh={false} />
                <button type="submit" className="dsh-workbench-action" disabled={evaluating || !ready}>{evaluating ? '评估中…' : '开始批量评估'}</button>
              </fieldset>
            </form>
            {notices[batchKey] && <p role="status">{notices[batchKey]}</p>}
            {tasks(context, 'evaluate-batch')}
          </LibraryTaskDialog>}
        </>
      }}
      renderGraphActions={context => {
        if (!context.library) return null
        const key = jobKey(context, 'analyze')
        return <>
          <GraphAction context={context} busy={!!busy[key]} running={!!running[key]} onStart={() => void start(context, 'analyze')} />
          <button type="button" className="dsh-workbench-action dsh-graph-history-button" aria-haspopup="dialog" onClick={() => setOpenGraph(key)}>建图记录</button>
          <LibraryTaskDialog heading="建图记录" libraryName={context.library.name} open={active && openGraph === key} onClose={() => setOpenGraph(null)}>
            {tasks(context, 'analyze')}
          </LibraryTaskDialog>
          {active && graphNotice?.key === key && <div className="dsh-graph-toast" role="status">{graphNotice.text}</div>}
        </>
      }}
      renderSkillActions={context => context.library && context.selectedSkill && <div className="dsh-skill-actions" role="group" aria-label="当前技能操作">
        <button className="dsh-workbench-action" aria-label="使用此技能" title="在 DSH 对话中使用" disabled={!context.localData?.source.skills.some(skill => skill.id === context.selectedSkill!.id)} onClick={() => setUseSelection({ kind: 'skill', sourcePath: context.library!.sourcePath, skillId: context.selectedSkill!.id, libraryName: context.library!.name, name: context.selectedSkill!.name })}><ArrowUpRight size={18} strokeWidth={1.8} aria-hidden="true" />使用</button>
        <RemoveInstalledSkill management={installations} filePath={context.localData?.source.skills.find(skill => skill.id === context.selectedSkill?.id)?.path} />
        <TrackInstalledSkillUpdate management={installations} filePath={context.localData?.source.skills.find(skill => skill.id === context.selectedSkill?.id)?.path} />
      </div>}
      renderSkillResult={context => context.library && context.selectedSkill && <section className="inspector-section skill-quality-section" aria-label="质量评估">
        <div className="section-heading"><h3 className="skill-section-label">质量评估</h3>
          <button type="button" className="dsh-workbench-action quality-action" aria-label="评估技能" aria-haspopup="dialog" title="检查当前技能的质量" disabled={busy[jobKey(context, 'evaluate')] || running[jobKey(context, 'evaluate')] || !context.localData?.source.skills.some(skill => skill.id === context.selectedSkill!.id)} onClick={() => setConfirmation({ context, action: 'evaluate' })}><ListChecks size={16} strokeWidth={1.8} aria-hidden="true" />评估</button>
        </div>
        {tasks(context, 'evaluate')}
      </section>}
    />
    {confirmation && <ModelOperationDialog context={confirmation.context} target={target} disabled={Boolean(busy[jobKey(confirmation.context, confirmation.action)] || running[jobKey(confirmation.context, confirmation.action)])} onClose={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); void start(confirmation.context, confirmation.action) }} />}
    {useSelection && <ConversationDraftDialog selection={useSelection} onClose={() => setUseSelection(null)} onUseSkill={onUseSkill} onRouteDraft={selection => { onRouteDraft(selection); setMatchingOpen(false) }} />}
    <InstallationManagementDialog management={installations} />
  </>
}
