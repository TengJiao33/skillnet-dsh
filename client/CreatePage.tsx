import React, { useEffect, useRef, useState } from 'react'
import { FileText, FolderGit2, MessageSquare, PenLine, Route, Upload } from 'lucide-react'
import { api } from './api'
import { Select } from './Select'
import { ModelChoice, TaskList } from './operations'
import type { ModelTarget } from './operations'

const sources = { prompt: '描述需求', conversation: 'DSH 对话', trajectory: '任务记录', document: '文档', github: 'GitHub 仓库' }
const sourceIcons = { prompt: PenLine, conversation: MessageSquare, trajectory: Route, document: FileText, github: FolderGit2 }
type Source = keyof typeof sources

export function CreatePage({ active, target, onTarget }: { active: boolean, target: ModelTarget, onTarget: (value: ModelTarget) => void }) {
  const [type, setType] = useState<Source>('prompt')
  const [inputs, setInputs] = useState<Record<Source, string>>({ prompt: '', conversation: '', trajectory: '', document: '', github: '' })
  const [contexts, setContexts] = useState<any>(null)
  const [sourceSessionId, setSourceSessionId] = useState('')
  const [documentName, setDocumentName] = useState('')
  const [documentTruncated, setDocumentTruncated] = useState(false)
  const [documentLength, setDocumentLength] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [running, setRunning] = useState(false)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [latestTaskId, setLatestTaskId] = useState<string>()
  const [scrollToDraft, setScrollToDraft] = useState(false)
  const pending = useRef(false)
  const upload = useRef<HTMLInputElement>(null)
  const result = useRef<HTMLDivElement>(null)
  const readController = useRef<AbortController | null>(null)
  const locked = submitting || running || Boolean(pendingTaskId)
  const content = inputs[type]
  const selectedModel = target.sessionId ? contexts?.sessions.find((item: any) => item.sessionId === target.sessionId) : null
  const modelLabel = target.modelSource === 'sdk' ? '独立 API（高级）' : selectedModel?.selection?.model || (!target.sessionId && contexts?.default?.model) || (target.sessionId ? '所选 DSH 对话的模型' : 'DSH 默认模型')
  useEffect(() => () => readController.current?.abort(), [])
  useEffect(() => {
    if (!active || !scrollToDraft) return
    result.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    setScrollToDraft(false)
  }, [active, scrollToDraft])

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
  async function readDocument(file?: File) {
    if (!file || locked) return
    readController.current?.abort()
    readController.current = null
    setReading(false)
    setError('')
    setDocumentName('')
    setDocumentTruncated(false)
    setDocumentLength(0)
    setInputs(previous => ({ ...previous, document: '' }))
    if (file.size > 4 * 1024 * 1024) {
      setError('文档须在 4 MB 以内。')
      return
    }
    const controller = new AbortController()
    readController.current = controller
    setReading(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (controller.signal.aborted) return
      const pieces = []
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
      }
      const value = await api('document-preview', { name: file.name, data: btoa(pieces.join('')) }, controller.signal)
      if (controller.signal.aborted) return
      setDocumentName(file.name)
      setDocumentTruncated(value.truncated)
      setDocumentLength([...value.content].length)
      setInputs(previous => ({ ...previous, document: value.content }))
    } catch (cause: any) {
      if (!controller.signal.aborted) setError(cause.message)
    } finally {
      if (readController.current === controller) { readController.current = null; setReading(false) }
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || locked || reading || !content.trim()) return
    pending.current = true; setSubmitting(true); setError('')
    try {
      const inputType = type === 'document' ? 'prompt' : type
      const task = await api('start', { ...target, action: 'create', input_type: inputType, content })
      setLatestTaskId(task.id); setPendingTaskId(task.id); setRevision(value => value + 1)
    } catch (cause: any) { setError(cause.message) }
    finally { pending.current = false; setSubmitting(false) }
  }
  return <main className="dsh-page dsh-create-page" hidden={!active}>
    <header className="dsh-create-heading"><h1>创建技能</h1><p>将需求、对话或已有材料整理为可复用的技能草稿。</p></header>
    <form onSubmit={event => void submit(event)}>
      <fieldset className="dsh-create-fields" disabled={locked}>
        <legend>创建来源</legend>
        <div className="dsh-create-sources" role="radiogroup" aria-label="创建来源">
          {(Object.entries(sources) as [Source, string][]).map(([value, label]) => {
            const Icon = sourceIcons[value]
            return <label key={value}><input type="radio" name="skillnet-create-source" value={value} checked={type === value} onChange={() => changeSource(value)} /><span><Icon size={14} strokeWidth={1.8} aria-hidden="true" />{label}</span></label>
          })}
        </div>
        {type === 'conversation' && <div className="dsh-create-conversation">
          <label><span>来源对话</span><Select compact aria-label="来源对话" value={sourceSessionId} onValueChange={value => {
            readController.current?.abort(); readController.current = null; setReading(false); setSourceSessionId(value); setInputs(previous => ({ ...previous, conversation: '' })); setError('')
          }}><option value="" disabled>{contexts ? '请选择来源对话' : '正在读取对话列表…'}</option>{contexts?.sessions.map((item: any) => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}</Select></label>
          <button type="button" disabled={reading || !sourceSessionId} onClick={() => void readConversation()}>{reading ? '正在读取…' : '读取内容'}</button>
        </div>}
        {type === 'document' && <div className="dsh-create-upload" data-dragging={dragging} onDragOver={event => {
          event.preventDefault(); if (!locked) setDragging(true)
        }} onDragLeave={event => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
        }} onDrop={event => {
          event.preventDefault(); setDragging(false); void readDocument(event.dataTransfer.files[0])
        }}>
          <input ref={upload} type="file" aria-label="选择文档" accept=".md,.txt,.docx,.pdf" hidden onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void readDocument(file)
          }} />
          <Upload size={19} strokeWidth={1.8} aria-hidden="true" />
          <div>{reading ? <p role="status">正在提取文字…</p> : documentName
            ? <><p role="status" title={documentName}>已读取 {documentName}{documentTruncated ? '，仅保留前 50,000 字符' : ''}</p><small>{documentLength.toLocaleString('zh-CN')} 字符</small></>
            : <><strong>拖入文档或从本机选择</strong><small>Markdown、TXT、Word、PDF · 最大 4 MB</small></>}</div>
          <button type="button" disabled={locked || reading} onClick={() => upload.current?.click()}>{documentName ? '更换文档' : '选择文档'}</button>
        </div>}
        <label className="dsh-create-input"><span>{type === 'prompt' ? '希望复用什么能力？' : type === 'trajectory' ? '任务过程与结果' : type === 'conversation' ? '对话内容' : type === 'document' ? '提取内容' : '仓库链接'}</span>
          {type === 'github' ? <input type="url" aria-label="仓库链接" required value={content} onChange={event => setContent(event.target.value)} placeholder="https://github.com/owner/repository" /> : <textarea aria-label="创建内容" required rows={7} disabled={reading} value={content} onChange={event => setContent(event.target.value)} placeholder={type === 'prompt' ? '描述技能的用途、处理步骤和期望产物。' : type === 'trajectory' ? '粘贴一次任务的目标、关键步骤和最终结果。' : type === 'document' ? '选择文档后，可以先编辑提取的文字。' : '选择来源对话并读取，可在这里编辑后生成。'} />}
        </label>
        <p className="dsh-create-hint">{type === 'prompt' ? '例如：把 CSV 数据检查、论文图表绘制和 SVG 导出整理成一套可复用流程。' : type === 'trajectory' ? '保留有用的方法和注意事项，帮助技能复现这次任务的做法。' : type === 'conversation' ? '读取后请检查内容，保留希望复用的方法与经验。' : type === 'document' ? '提取文字后确认内容，再提交生成草稿。' : '从仓库中的已有方法与文档整理技能。'}</p>
        <details className="dsh-create-model"><summary><span>使用模型</span><strong>{modelLabel}</strong><span>更改</span></summary><ModelChoice value={target} onChange={onTarget} onLoad={setContexts} /></details>
      </fieldset>
      <footer className="dsh-create-footer"><button type="submit" className="primary-button" disabled={locked || reading || !content.trim()}>{locked ? '正在生成…' : '生成技能草稿'}</button></footer>
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div ref={result}><TaskList revision={revision} latestTaskId={latestTaskId} onlyAction="create" enabled={active} onRunningChange={setRunning}
      onComplete={task => { if (task.id === latestTaskId) setScrollToDraft(true) }}
      onSettled={task => setPendingTaskId(current => current === task.id ? null : current)} /></div>
  </main>
}
