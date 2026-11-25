import React, { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { Select } from './Select'

const names: Record<string, string> = { analyze: '建图', route: '技能匹配', create: '创建技能', evaluate: '评估' }
const states: Record<string, string> = { running: '进行中', stopping: '取消中', completed: '已完成', failed: '失败', killed: '已取消' }

function EvaluationReport({ task }: { task: any }) {
  return <div className="dsh-evaluation-report" aria-label="技能评估结果">
    {task.resultError && <p role="alert">{task.resultError}</p>}
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

export function TaskList({ revision, latestTaskId, sourcePath, onlyAction, skillId, enabled = true, compact = false, onUse, onComplete, onRunningChange, onSettled, onPick, onViewGraph, onRetryRelations, retryDisabled }: { revision: number, latestTaskId?: string, sourcePath?: string, onlyAction?: string, skillId?: string, enabled?: boolean, compact?: boolean, onUse?: (task: any) => void, onComplete?: (task: any) => void, onRunningChange?: (running: boolean) => void, onSettled?: (task: any) => void, onPick?: (id: string) => void, onViewGraph?: () => void, onRetryRelations?: (id: string) => void, retryDisabled?: boolean }) {
  const [tasks, setTasks] = useState<any[]>([])
  const [detail, setDetail] = useState<any>(null)
  const [evaluation, setEvaluation] = useState<any>(null)
  const [error, setError] = useState('')
  const [previewing, setPreviewing] = useState('')
  const settled = useRef(onSettled); settled.current = onSettled
  const seen = useRef(new Set<string>())
  const pending = useRef(new Set<string>())
  const complete = useRef(onComplete); complete.current = onComplete
  const runningChange = useRef(onRunningChange); runningChange.current = onRunningChange
  const persistentEvaluation = compact && onlyAction === 'evaluate' && Boolean(sourcePath && skillId)
  useEffect(() => { runningChange.current?.(tasks.length > 0) }, [tasks])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api('tasks', { limit: 30, sourcePath, action: onlyAction, skillId }, controller.signal)
        if (controller.signal.aborted) return
        const latest = latestTaskId ?? (onlyAction === 'analyze' ? result.items[0]?.id : undefined)
        const values = result.items.filter((task: any) => ['running', 'stopping'].includes(task.status) || task.id === latest || pending.current.has(task.id))
        const running = values.filter((task: any) => ['running', 'stopping'].includes(task.status))
        setTasks(running)
        if (persistentEvaluation) {
          const saved = await api('evaluation', { sourcePath, skillId }, controller.signal)
          if (controller.signal.aborted) return
          setEvaluation(saved)
        }
        for (const task of values) {
          if (['running', 'stopping'].includes(task.status)) pending.current.add(task.id)
          else if (!seen.current.has(task.id)) {
            const detail = await api('task', { id: task.id }, controller.signal)
            if (controller.signal.aborted) return
            if (seen.current.has(task.id)) continue
            if (persistentEvaluation && detail.status === 'completed') { setEvaluation((previous: any) => previous && previous.startedAt > detail.startedAt ? previous : detail); setDetail(null) }
            else setDetail(detail)
            seen.current.add(task.id)
            pending.current.delete(task.id)
            settled.current?.(detail)
            if (task.status === 'completed') complete.current?.(task)
          }
        }
        setError('')
      } catch (cause: any) { if (!controller.signal.aborted) setError(cause.message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [revision, latestTaskId, sourcePath, onlyAction, skillId, enabled, persistentEvaluation])
  useEffect(() => { setEvaluation(null) }, [sourcePath, onlyAction, skillId])
  useEffect(() => { setDetail(null); setError('') }, [latestTaskId, sourcePath, onlyAction, skillId])
  async function open(id: string) {
    try {
      const task = await api('task', { id })
      if (!['running', 'stopping'].includes(task.status)) {
        setTasks(values => values.filter(value => value.id !== id))
        const first = !seen.current.has(id)
        seen.current.add(id); pending.current.delete(id)
        settled.current?.(task)
        if (first && task.status === 'completed') complete.current?.(task)
      }
      if (persistentEvaluation && task.status === 'completed') { setEvaluation((previous: any) => previous && previous.startedAt > task.startedAt ? previous : task); setDetail(null) }
      else setDetail(task)
    } catch (e: any) { setError(e.message) }
  }
  async function previewDraft(taskId: string, name: string) {
    if (previewing) return
    setPreviewing(name)
    try { const value = await api('publish', { id: taskId, name }); window.dispatchEvent(new CustomEvent('skillnet-preview', { detail: value })) }
    catch (cause: any) { setError(cause.message) }
    finally { setPreviewing('') }
  }
  if (!tasks.length && !detail && !evaluation && !error) return null
  return <section className="dsh-tasks">
    {error && <p role="alert">{error}</p>}
    {tasks.map(task => <div className="dsh-task" key={task.id}>
        <button onClick={() => void open(task.id)}>{names[task.action]} <span>{states[task.status]}</span></button>
        <span>{task.error || task.progress || new Date(task.startedAt).toLocaleString()}</span>
        {['running', 'stopping'].includes(task.status) && <button onClick={() => void api('cancel', { id: task.id }).then(() => open(task.id)).catch(e => setError(e.message))}>取消</button>}
      </div>)}
    {detail && <section className="dsh-result" aria-label="作业结果"><div className="dsh-row"><h3>{detail.action === 'create' && detail.status === 'completed' ? '生成的草稿' : `${names[detail.action]} ${states[detail.status]}`}</h3><button onClick={() => setDetail(null)}>关闭</button></div>
      {detail.error && <p role="alert">{detail.error}</p>}
      {detail.resultError && <p role="alert">{detail.resultError}</p>}
      {detail.result?.skills?.map((skill: any) => <button className="dsh-route-result" key={skill.skill_id} onClick={() => onPick?.(skill.skill_id)}><strong>{skill.name}</strong><span>{skill.reason}</span></button>)}
      {detail.action === 'route' && detail.result?.skills?.length === 0 && <p>未找到适合该任务的技能。</p>}
      {detail.action === 'route' && detail.status === 'completed' && detail.result?.skills?.length > 0 && onUse && <button onClick={() => onUse(detail)}>在对话中使用</button>}
      {detail.result?.drafts?.map((draft: any) => <article className="dsh-create-draft" key={draft.name}>
        <h3>{draft.metadata?.name || draft.name}</h3>
        {typeof draft.metadata?.description === 'string' && <p>{draft.metadata.description}</p>}
        <div className="dsh-create-draft-footer">{draft.validation?.valid === false && <span className="dsh-create-invalid">结构校验未通过</span>}<button type="button" disabled={Boolean(previewing)} onClick={() => void previewDraft(detail.id, draft.name)}>{previewing === draft.name ? '正在打开…' : '查看草稿'}</button></div>
      </article>)}
      {detail.result?.warning && <p role="alert">{detail.result.warning}</p>}
      {detail.action === 'analyze' && detail.result && <div>
        <p>图谱已发布 · {detail.result.skill_count} 个技能</p>
        <div className="dsh-row">
          {onViewGraph && <button onClick={onViewGraph}>查看关系图</button>}
          <span>可组合 {detail.result.relation_counts?.compose_with || 0}</span><span>相似 {detail.result.relation_counts?.similar_to || 0}</span>
        </div>
        {detail.result.pending_profiles?.length > 0 && <p>画像待补：{detail.result.pending_profiles.join('、')}。</p>}
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
    </section>}
    {evaluation && <EvaluationReport task={evaluation} />}
  </section>
}
