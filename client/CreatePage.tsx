import React, { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { Select } from './Select'
import { ModelChoice, TaskList } from './operations'
import type { ModelTarget } from './operations'

const sources = { prompt: '描述需求', conversation: 'DSH 对话', trajectory: '任务记录', github: 'GitHub 仓库' }
type Source = keyof typeof sources

export function CreatePage({ target, onTarget }: { target: ModelTarget, onTarget: (value: ModelTarget) => void }) {
  const [type, setType] = useState<Source>('prompt')
  const [inputs, setInputs] = useState<Record<Source, string>>({ prompt: '', conversation: '', trajectory: '', github: '' })
  const [contexts, setContexts] = useState<any>(null)
  const [sourceSessionId, setSourceSessionId] = useState('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [running, setRunning] = useState(false)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [latestTaskId, setLatestTaskId] = useState<string>()
  const pending = useRef(false)
  const readController = useRef<AbortController | null>(null)
  const locked = submitting || running || Boolean(pendingTaskId)
  const content = inputs[type]
  const selectedModel = target.sessionId ? contexts?.sessions.find((item: any) => item.sessionId === target.sessionId) : null
  const modelLabel = target.modelSource === 'sdk' ? '独立 API（高级）' : selectedModel?.selection?.model || (!target.sessionId && contexts?.default?.model) || (target.sessionId ? '所选 DSH 对话的模型' : 'DSH 默认模型')
  useEffect(() => () => readController.current?.abort(), [])

  function changeSource(value: Source) {
    readController.current?.abort(); readController.current = null
    setReading(false); setError(''); setType(value)
  }
  function setContent(value: string) { setInputs(previous => ({ ...previous, [type]: value })) }
  async function readConversation() {
    if (!sourceSessionId || reading || locked) return
    const controller = new AbortController(); readController.current = controller
    setReading(true); setError('')
    try {
      const value = await api('conversation', { sessionId: sourceSessionId }, controller.signal)
      if (!controller.signal.aborted) setInputs(previous => ({ ...previous, conversation: value.content }))
    } catch (cause: any) { if (!controller.signal.aborted) setError(cause.message) }
    finally { if (readController.current === controller) { readController.current = null; setReading(false) } }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || locked || reading || !content.trim()) return
    pending.current = true; setSubmitting(true); setError('')
    try {
      // Conversation text has already been read and can be edited here. The
      // existing backend receives the same input types and content unchanged;
      // target.sessionId selects the model independently of the source chat.
      const task = await api('start', { ...target, action: 'create', input_type: type, content })
      setLatestTaskId(task.id); setPendingTaskId(task.id); setRevision(value => value + 1)
    } catch (cause: any) { setError(cause.message) }
    finally { pending.current = false; setSubmitting(false) }
  }
  return <main className="dsh-page dsh-create-page">
    <header className="dsh-create-heading"><h1>创建技能</h1><p>将需求、对话或已有材料整理为可复用的技能草稿。</p></header>
    <form onSubmit={event => void submit(event)}>
      <fieldset className="dsh-create-fields" disabled={locked}>
        <legend>创建来源</legend>
        <div className="dsh-create-sources" role="radiogroup" aria-label="创建来源">
          {(Object.entries(sources) as [Source, string][]).map(([value, label]) => <label key={value}><input type="radio" name="skillnet-create-source" value={value} checked={type === value} onChange={() => changeSource(value)} /><span>{label}</span></label>)}
        </div>
        {type === 'conversation' && <div className="dsh-create-conversation">
          <label><span>来源对话</span><Select compact aria-label="来源对话" value={sourceSessionId} onValueChange={value => {
            readController.current?.abort(); readController.current = null; setReading(false); setSourceSessionId(value); setInputs(previous => ({ ...previous, conversation: '' })); setError('')
          }}><option value="" disabled>{contexts ? '请选择来源对话' : '正在读取对话列表…'}</option>{contexts?.sessions.map((item: any) => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}</Select></label>
          <button type="button" disabled={reading || !sourceSessionId} onClick={() => void readConversation()}>{reading ? '正在读取…' : '读取内容'}</button>
        </div>}
        <label className="dsh-create-input"><span>{type === 'prompt' ? '希望复用什么能力？' : type === 'trajectory' ? '任务过程与结果' : type === 'conversation' ? '对话内容' : '仓库链接'}</span>
          {type === 'github' ? <input type="url" aria-label="仓库链接" required value={content} onChange={event => setContent(event.target.value)} placeholder="https://github.com/owner/repository" /> : <textarea aria-label="创建内容" required rows={7} disabled={reading} value={content} onChange={event => setContent(event.target.value)} placeholder={type === 'prompt' ? '描述技能的用途、处理步骤和期望产物。' : type === 'trajectory' ? '粘贴一次任务的目标、关键步骤和最终结果。' : '选择来源对话并读取，可在这里编辑后生成。'} />}
        </label>
        <p className="dsh-create-hint">{type === 'prompt' ? '例如：把 CSV 数据检查、论文图表绘制和 SVG 导出整理成一套可复用流程。' : type === 'trajectory' ? '保留有用的方法和注意事项，帮助技能复现这次任务的做法。' : type === 'conversation' ? '读取后请检查内容，保留希望复用的方法与经验。' : '从仓库中的已有方法与文档整理技能。'}</p>
        <details className="dsh-create-model"><summary><span>使用模型</span><strong>{modelLabel}</strong><span>更改</span></summary><ModelChoice value={target} onChange={onTarget} onLoad={setContexts} /></details>
      </fieldset>
      <footer className="dsh-create-footer"><button type="submit" className="primary-button" disabled={locked || reading || !content.trim()}>{locked ? '正在生成…' : '生成技能草稿'}</button></footer>
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <TaskList revision={revision} latestTaskId={latestTaskId} onlyAction="create" onRunningChange={setRunning} onSettled={task => setPendingTaskId(current => current === task.id ? null : current)} />
  </main>
}
