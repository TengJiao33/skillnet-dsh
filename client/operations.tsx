import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, Check, Copy, Loader2 } from 'lucide-react'
import { api } from './api'
import { Select } from './Select'

const names: Record<string, string> = { analyze: '建图', route: '技能匹配', create: '创建技能', evaluate: '评估', 'evaluate-batch': '批量评估' }
const states: Record<string, string> = { running: '进行中', stopping: '取消中', completed: '已完成', failed: '失败', killed: '已取消' }
const retrievalModes: Record<string, string> = { model: '仅使用模型', vector: '向量检索' }
const evaluationVersions: Record<string, string> = { current: '当前版本', historical: '历史结果 · 技能包已变化', unversioned: '历史结果 · 版本未记录' }
const batchStatuses: Record<string, string> = { completed: '已评估', failed: '失败', skipped: '已有当前版本评估', unattempted: '待评估' }
const activePollIntervals = [200, 400, 800, 1500, 3000]
const recentActions = new Set(['analyze', 'route', 'create', 'evaluate-batch'])
const isRunning = (task: any) => task.status === 'running' || task.status === 'stopping'

function EvaluationReport({ task }: { task: any }) {
  const scan = task.result?.prompt_injection_scan
  return <div className="dsh-evaluation-report" aria-label="技能评估结果">
    {task.resultError && <p role="alert">{task.resultError}</p>}
    {task.versionStatus && <p role="status">{evaluationVersions[task.versionStatus]}</p>}
    {scan?.count > 0 && <p role="status" className="dsh-evaluation-warning">发现 {scan.count} 处疑似提示注入。</p>}
    {scan?.complete === false && <p role="status" className="dsh-evaluation-warning">未能扫描整个技能包。</p>}
    {task.result && Object.entries({ safety: '安全性', completeness: '完整性', executability: '可执行性', cost_awareness: '成本意识', maintainability: '可维护性' }).map(([key, label]) => <section key={key}><h3>{label} <span>{{ Good: '良好', Average: '一般', Poor: '较弱' }[task.result[key]?.level as string] || task.result[key]?.level}</span></h3><p>{task.result[key]?.reason}</p></section>)}
  </div>
}

export type ModelTarget = { sessionId?: string, modelSource?: string }

export function ModelChoice({ value, onChange, onLoad, showRefresh = true }: { value: ModelTarget, onChange: (value: ModelTarget) => void, onLoad?: (contexts: any) => void, showRefresh?: boolean }) {
  const [contexts, setContexts] = useState<any>(null)
  const [error, setError] = useState('')
  async function load() { try { const value = await api('model-context'); setContexts(value); onLoad?.(value); setError('') } catch (e: any) { setError(e.message) } }
  useEffect(() => { void load() }, [])
  const model = contexts?.default
  const selected = value.modelSource === 'sdk' ? '独立 API（高级）' : value.sessionId ? contexts?.sessions.find((item: any) => item.sessionId === value.sessionId) : null
  const title = typeof selected === 'string' ? selected : selected ? `${selected.title}${selected.selection ? ` / ${selected.selection.model}` : ''}` : `DSH 默认模型${model ? ` / ${model.model}` : ''}`
  return <div className="dsh-model-choice"><label className="collection-control dsh-model-label"><span>使用模型</span><Select aria-label="使用模型" title={title} value={value.modelSource === 'sdk' ? 'sdk' : value.sessionId || ''} onValueChange={value => onChange(value === 'sdk' ? { modelSource: 'sdk' } : { sessionId: value || undefined })}>
    <option value="">DSH 默认模型{model ? ` / ${model.model}` : ''}</option>
    {contexts?.sessions.map((item: any) => <option key={item.sessionId} value={item.sessionId}>{item.title}{item.selection ? ` / ${item.selection.model}` : ''}</option>)}
    <option value="sdk">独立 API（高级）</option>
  </Select></label>{showRefresh && <button type="button" onClick={() => void load()}>刷新对话</button>}{error && <span role="alert">{error}</span>}</div>
}

export function TaskList({ revision, latestTaskId, sourcePath, onlyAction, skillId, enabled = true, compact = false, showHistory = false, onUse, onComplete, onRunningChange, onSettled, onPick, onViewGraph, onRetryProfiles, onRetryRelations, onRetryBatch, retryDisabled }: { revision: number, latestTaskId?: string, sourcePath?: string, onlyAction?: string, skillId?: string, enabled?: boolean, compact?: boolean, showHistory?: boolean, onUse?: (task: any) => void, onComplete?: (task: any) => void, onRunningChange?: (running: boolean) => void, onSettled?: (task: any, wasRunning: boolean) => void, onPick?: (id: string) => void, onViewGraph?: () => void, onRetryProfiles?: () => void, onRetryRelations?: (id: string) => void, onRetryBatch?: (id: string) => void, retryDisabled?: boolean }) {
  const [tasks, setTasks] = useState<any[] | null>(null)
  const [history, setHistory] = useState<any[]>([])
  const [latestDetail, setLatestDetail] = useState<any>(null)
  const [selectedDetail, setSelectedDetail] = useState<any>(null)
  const detail = selectedDetail || latestDetail
  const [evaluation, setEvaluation] = useState<any>(null)
  const [error, setError] = useState('')
  const [previewing, setPreviewing] = useState('')
  const previewRequest = useRef(false)
  const [cancelling, setCancelling] = useState<string[]>([])
  const [copied, setCopied] = useState('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copySequence = useRef(0)
  const pollNow = useRef<(() => void) | undefined>(undefined)
  const readSequence = useRef(0)
  const settled = useRef(onSettled); settled.current = onSettled
  const seen = useRef(new Set<string>())
  const pending = useRef(new Set<string>())
  const complete = useRef(onComplete); complete.current = onComplete
  const runningChange = useRef(onRunningChange); runningChange.current = onRunningChange
  const persistentEvaluation = compact && onlyAction === 'evaluate' && Boolean(sourcePath && skillId)
  useEffect(() => () => { copySequence.current++; clearTimeout(copyTimer.current) }, [])
  useEffect(() => { if (tasks) runningChange.current?.(tasks.length > 0) }, [tasks])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let step = 0
    let inFlight = false
    let evaluationLoaded = false
    const poll = async () => {
      inFlight = true
      let active = Boolean(latestTaskId)
      try {
        const result = await api('tasks', { limit: 30, sourcePath, action: onlyAction, skillId }, controller.signal)
        if (controller.signal.aborted) return
        const latest = latestTaskId ?? (recentActions.has(onlyAction || '') ? result.items[0]?.id : undefined)
        const values = result.items.filter((task: any) => isRunning(task) || task.id === latest || pending.current.has(task.id))
        const running = values.filter(isRunning)
        active = running.length > 0 || Boolean(latestTaskId && !values.some((task: any) => task.id === latestTaskId))
        setTasks(running)
        if (showHistory) setHistory(result.items.filter((task: any) => !isRunning(task)))
        if (persistentEvaluation && (!evaluationLoaded || !running.length || values.some((task: any) => !isRunning(task) && !seen.current.has(task.id)))) {
          const saved = await api('evaluation', { sourcePath, skillId }, controller.signal)
          if (controller.signal.aborted) return
          setEvaluation(saved)
          evaluationLoaded = true
        }
        for (const task of values) {
          if (isRunning(task)) pending.current.add(task.id)
          else if (!seen.current.has(task.id)) {
            const resultDetail = await api('task', { id: task.id }, controller.signal)
            if (controller.signal.aborted) return
            if (seen.current.has(task.id)) continue
            if (persistentEvaluation && resultDetail.status === 'completed') setLatestDetail(null)
            else if (task.id === latest || !latest) setLatestDetail(resultDetail)
            seen.current.add(task.id)
            const wasRunning = pending.current.delete(task.id)
            settled.current?.(resultDetail, wasRunning)
            if (task.status === 'completed') complete.current?.(task)
          }
        }
        setError('')
      } catch (cause: any) { if (!controller.signal.aborted) setError(cause.message) }
      finally {
        inFlight = false
        if (!active) step = 0
        if (!controller.signal.aborted) timer = setTimeout(poll, active ? activePollIntervals[Math.min(step++, activePollIntervals.length - 1)] : 10_000)
      }
    }
    pollNow.current = () => {
      step = 0
      clearTimeout(timer)
      if (!inFlight) void poll()
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer); pollNow.current = undefined }
  }, [revision, latestTaskId, sourcePath, onlyAction, skillId, enabled, persistentEvaluation, showHistory])
  useEffect(() => { setEvaluation(null) }, [sourcePath, onlyAction, skillId])
  useEffect(() => { setLatestDetail(null); setError('') }, [latestTaskId, sourcePath, onlyAction, skillId])
  useEffect(() => { setSelectedDetail(null); readSequence.current++ }, [sourcePath, onlyAction, skillId])
  async function open(id: string, fromHistory = false) {
    const sequence = ++readSequence.current
    try {
      const task = await api('task', { id })
      if (sequence !== readSequence.current) return
      if (!isRunning(task) && !fromHistory) {
        setTasks(values => values?.filter(value => value.id !== id) ?? [])
        const first = !seen.current.has(id)
        seen.current.add(id)
        const wasRunning = pending.current.delete(id)
        if (first) {
          settled.current?.(task, wasRunning)
          if (task.status === 'completed') complete.current?.(task)
        }
      }
      if (persistentEvaluation && task.status === 'completed') {
        setEvaluation(await api('evaluation', { sourcePath, skillId }))
        setLatestDetail(null)
      }
      else if (fromHistory) setSelectedDetail(task)
      else setLatestDetail(task)
    } catch (e: any) { setError(e.message) }
  }
  async function cancel(id: string) {
    if (cancelling.includes(id)) return
    setCancelling(value => [...value, id])
    pollNow.current?.()
    try { await api('cancel', { id }); await open(id) }
    catch (cause: any) { setError(cause.message) }
    finally { setCancelling(value => value.filter(taskId => taskId !== id)); pollNow.current?.() }
  }
  async function previewDraft(taskId: string, name: string) {
    if (previewRequest.current) return
    previewRequest.current = true
    setPreviewing(name)
    try { const value = await api('publish', { id: taskId, name }); window.dispatchEvent(new CustomEvent('skillnet-preview', { detail: value })) }
    catch (cause: any) { setError(cause.message) }
    finally { previewRequest.current = false; setPreviewing('') }
  }
  async function copyError(task: { id: string, error: string }) {
    const sequence = ++copySequence.current
    clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(task.error)
      if (sequence !== copySequence.current) return
      setCopied(task.id)
      copyTimer.current = setTimeout(() => setCopied(''), 2000)
    } catch {
      if (sequence === copySequence.current) setCopied('failed:' + task.id)
    }
  }
  const routeSeconds = detail?.action === 'route' && detail.finishedAt ? (Date.parse(detail.finishedAt) - Date.parse(detail.startedAt)) / 1000 : NaN
  const routeDuration = Number.isFinite(routeSeconds) && routeSeconds >= 0
    ? `作业耗时 ${routeSeconds.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒` : null
  const routeSummary = [retrievalModes[detail?.retrievalMode], routeDuration].filter(Boolean).join(' · ')
  if (!tasks?.length && !detail && !evaluation && !error && !history.length)
    return showHistory && tasks ? <p>暂无建图记录。</p> : null
  return <section className="dsh-tasks">
    {error && <p role="alert">{error}</p>}
    {tasks?.map(task => <div className="dsh-task" key={task.id}>
        <button type="button" onClick={() => void open(task.id)}>{task.action === 'analyze' && <Loader2 className="dsh-progress-icon" size={15} aria-hidden="true" />}{names[task.action]} <span>{states[cancelling.includes(task.id) ? 'stopping' : task.status]}</span></button>
        <span>{task.error || task.progress || new Date(task.startedAt).toLocaleString()}</span>
        {['running', 'stopping'].includes(task.status) && <button disabled={task.status === 'stopping' || cancelling.includes(task.id)} onClick={() => void cancel(task.id)}>取消</button>}
      </div>)}
    {showHistory && selectedDetail && latestDetail && latestDetail.id !== selectedDetail.id && <button type="button" className="dsh-latest-task" onClick={() => { readSequence.current++; setSelectedDetail(null) }}>查看最新记录</button>}
    {detail && <section className="dsh-result" aria-label="作业结果"><div className="dsh-row"><h3>{detail.action === 'create' && detail.status === 'completed' ? '生成的草稿' : `${names[detail.action]} ${states[detail.status]}`}</h3>{!showHistory && detail.action !== 'route' && detail.action !== 'evaluate-batch' && <button type="button" onClick={() => setLatestDetail(null)}>关闭</button>}</div>
      {detail.error && (detail.action === 'analyze' && detail.status === 'failed' ? <div className="dsh-graph-error">
        <div className="dsh-row"><AlertCircle size={16} aria-hidden="true" /><strong>失败详情</strong>
          <button type="button" data-copied={copied === detail.id} onClick={() => void copyError(detail)}>
            {copied === detail.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span aria-live="polite">{copied === detail.id ? '已复制' : copied === 'failed:' + detail.id ? '复制失败，重试' : '复制'}</span>
          </button>
        </div>
        <pre role="alert">{detail.error}</pre>
      </div> : <p role="alert">{detail.error}</p>)}
      {detail.resultError && <p role="alert">{detail.resultError}</p>}
      {detail.action === 'route' && <>
        {detail.query && <p>{detail.query}</p>}
        {routeSummary && <p className="dsh-route-meta">{routeSummary}</p>}
      </>}
      {detail.result?.skills?.map((skill: any) => <button type="button" className="dsh-route-result" key={skill.skill_id} onClick={() => onPick?.(skill.skill_id)}><strong>{skill.name}</strong><span>{skill.reason}</span><ArrowUpRight size={16} aria-hidden="true" /></button>)}
      {detail.action === 'route' && detail.result?.skills?.length === 0 && <p>未找到适合该任务的技能。</p>}
      {detail.action === 'route' && detail.status === 'completed' && detail.result?.skills?.length > 0 && onUse && <footer className="dsh-result-actions"><button type="button" className="primary-button" onClick={() => onUse(detail)}>添加到对话草稿</button></footer>}
      {detail.result?.drafts?.map((draft: any) => <article className="dsh-create-draft" key={draft.name}>
        <h3>{draft.metadata?.name || draft.name}</h3>
        {typeof draft.metadata?.description === 'string' && <p>{draft.metadata.description}</p>}
        <div className="dsh-create-draft-footer">{draft.validation?.valid === false && <span className="dsh-create-invalid">结构校验未通过</span>}<button type="button" aria-disabled={Boolean(previewing)} disabled={Boolean(previewing) && previewing !== draft.name} onClick={() => void previewDraft(detail.id, draft.name)}>{previewing === draft.name ? '正在打开…' : '查看草稿'}</button></div>
      </article>)}
      {detail.result?.warning && <p role="alert">{detail.result.warning}</p>}
      {detail.action === 'analyze' && detail.result && <div>
        <p>图谱已发布 · {detail.result.skill_count} 个技能</p>
        <div className="dsh-row">
          {onViewGraph && <button onClick={onViewGraph}>查看关系图</button>}
          <span>可组合 {detail.result.relation_counts?.compose_with || 0}</span><span>相似 {detail.result.relation_counts?.similar_to || 0}</span>
        </div>
        {detail.result.pending_profiles?.length > 0 && <details>
          <summary>{detail.result.pending_profiles.length} 项画像待补</summary>
          <p>{detail.result.pending_profiles.join('、')}</p>
          {onRetryProfiles && <button disabled={retryDisabled} onClick={onRetryProfiles}>补齐画像</button>}
        </details>}
        {detail.result.pending_relations > 0 && <details>
          <summary>还有 {detail.result.pending_relations} 对候选未能判断</summary>
          {onRetryRelations && <button disabled={retryDisabled} onClick={() => onRetryRelations(detail.id)}>重试这 {detail.result.pending_relations} 对</button>}
        </details>}
        {detail.result.seconds && <details>
          <summary>{detail.result.retried_candidates ? '复核' : '建图'}耗时 · {Math.round(detail.result.seconds.total)} 秒</summary>
          {detail.result.retried_candidates ? <p>本次仅复核 {detail.result.retried_candidates} 对候选。</p> : <>
            <p>画像 {Math.round(detail.result.seconds.profiles)} 秒，向量与候选 {Math.round(detail.result.seconds.retrieval)} 秒{(detail.result.model_calls?.screen || detail.result.screened_out) > 0 && `，初筛 ${Math.round(detail.result.seconds.screen)} 秒`}，关系复核 {Math.round(detail.result.seconds.relations)} 秒。</p>
            <p>共 {detail.result.candidate_pairs} 对候选{detail.result.screened_out > 0 && `，初筛排除 ${detail.result.screened_out} 对`}。</p>
          </>}
        </details>}
        {!compact && <p className="dsh-path">{detail.result.index_dir}</p>}
      </div>}
      {detail.action === 'evaluate' && detail.result && <EvaluationReport task={detail} />}
      {detail.action === 'evaluate-batch' && detail.result && <div aria-label="批量评估结果">
        <p>共 {detail.result.total} 项 · 已评估 {detail.result.completed} · 失败 {detail.result.failed} · 跳过 {detail.result.skipped ?? 0} · 待评估 {detail.result.unattempted}</p>
        {detail.result.items?.length > 0 && <details><summary>查看逐项结果</summary><ul>{detail.result.items.map((item: any) =>
          <li key={item.skillId}><button type="button" onClick={() => onPick?.(item.skillId)}>{item.skillId}</button> {batchStatuses[item.status]}{item.error && <p>{item.error}</p>}</li>
        )}</ul></details>}
        {detail.result.failed > 0 && onRetryBatch && <button disabled={retryDisabled} onClick={() => onRetryBatch(detail.id)}>重试失败技能</button>}
      </div>}
    </section>}
    {showHistory && history.some(task => task.id !== latestDetail?.id) && <details className="dsh-graph-history"><summary>更多记录</summary>
      <ul>{history.filter(task => task.id !== latestDetail?.id).map(task => <li key={task.id}>
        <button type="button" aria-current={selectedDetail?.id === task.id ? 'true' : undefined} onClick={() => void open(task.id, true)}><time dateTime={task.startedAt}>{new Date(task.startedAt).toLocaleString()}</time><span className="dsh-task-state" data-state={task.status}>{states[task.status]}</span></button>
      </li>)}</ul>
    </details>}
    {evaluation && <EvaluationReport task={evaluation} />}
  </section>
}
