import React, { useEffect, useRef, useState } from 'react'
import { SkillNetIcon } from './SkillNetIcon'
import { LibraryWorkbench } from './workbench'
import type { ModelTarget } from './operations'
import { CreatePage } from './CreatePage'
import { preloadWorkspace } from './upstream/src/useWorkspace'
import { api } from './api'
import { openSkillDraft, openAnalysisDraft } from './chatDraft'
import type { SkillDraft, AnalysisDraft } from './chatDraft'
import { Catalog } from './pages'
import { Select } from './Select'
import css from 'skillnet:styles'
import logo from 'skillnet:logo'

declare const __SKILLNET_BUILD__: string

function Settings() {
  const [settings, setSettings] = useState<any>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [clearSecrets, setClearSecrets] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const groups = [
    ['独立模型 API（高级）', [['base_url', 'OpenAI 兼容接口地址'], ['model', '模型'], ['api_key', 'API 密钥']]],
    ['向量模型（可选）', [['embedding_base_url', '接口地址'], ['embedding_model', '模型'], ['embedding_api_key', 'API 密钥']]],
    ['独立路由 API（高级）', [['explorer_base_url', 'DeepSeek Messages 接口地址'], ['explorer_model', '模型'], ['explorer_api_key', 'API 密钥']]],
  ] as const
  async function load() { try { setSettings(await api('settings')) } catch (e: any) { setMessage(e.message) } }
  useEffect(() => { void load() }, [])
  return <main className="dsh-page"><h1>模型设置</h1><form onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage(''); try { setSettings(await api('settings', { values, clearSecrets })); setValues({}); setClearSecrets([]); setMessage('已保存。') } catch (e: any) { setMessage(e.message) } finally { setBusy(false) } }}>
    <div className="dsh-settings-grid">{groups.map(([label, items]) => <section className="dsh-card" key={label}><h2>{label}</h2>{items.map(([key, name]) => <label key={key}>{name}
      <input type={key.endsWith('key') ? 'password' : 'text'} autoComplete="off" value={values[key] ?? (key.endsWith('key') ? '' : settings?.fields[key]?.value || '')} placeholder={key.endsWith('key') && settings?.fields[key]?.value ? '已配置，留空保留' : ''} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />
      {key.endsWith('key') && settings?.fields[key]?.value && <span className="dsh-clear"><input type="checkbox" checked={clearSecrets.includes(key)} onChange={e => setClearSecrets(v => e.target.checked ? [...v, key] : v.filter(x => x !== key))} />清除已保存的密钥</span>}
    </label>)}</section>)}</div><div className="dsh-row"><label>结构化输出 <Select aria-label="结构化输出" value={values.json_mode ?? settings?.fields.json_mode?.value ?? 'auto'} onValueChange={value => setValues(v => ({ ...v, json_mode: value }))}><option value="auto">自动</option><option value="on">严格 JSON Schema</option><option value="off">关闭协议参数</option></Select></label><button className="primary-button" disabled={busy}>保存设置</button></div><p role="status">{message}</p>
    {settings && <div className="dsh-checks">{Object.entries(settings.checks.dependencies).map(([name, found]) => <span key={name}>{{ graph: '图谱组件', claude: 'Claude 探索器', codex: 'Codex 探索器', dsh: 'DSH 探索器' }[name as 'graph' | 'claude' | 'codex' | 'dsh'] || name} {found ? '已就绪' : '未安装'}</span>)}</div>}
  </form></main>
}

function Panel({ onUseSkill, onAnalyze, onOpenAnalysis }: { onUseSkill: (selection: SkillDraft) => void, onAnalyze: (draft: AnalysisDraft) => void, onOpenAnalysis: (sessionId: string) => void }) {
  const [target, setTarget] = useState<ModelTarget>({})
  const [tab, setTab] = useState('workbench')
  const [preview, setPreview] = useState<any>(null)
  useEffect(() => { const listen = (event: Event) => { setPreview((event as CustomEvent).detail); setTab('discover') }; window.addEventListener('skillnet-preview', listen); return () => window.removeEventListener('skillnet-preview', listen) }, [])
  const navigation = <nav className="dsh-nav" aria-label="SkillNet"><button aria-current={tab === 'workbench' ? 'page' : undefined} onClick={() => setTab('workbench')}>我的技能库</button><button aria-current={tab === 'discover' ? 'page' : undefined} onClick={() => setTab('discover')}>发现</button><button aria-current={tab === 'create' ? 'page' : undefined} onClick={() => setTab('create')}>创建</button><button aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>设置</button></nav>
  return <div data-skillnet-build={__SKILLNET_BUILD__} className={`skillnet-shell ${tab !== 'workbench' ? 'dsh-other-page' : ''}`}><style>{css}</style>
    <LibraryWorkbench logo={logo} headerActions={navigation} active={tab === 'workbench'} target={target} onTarget={setTarget} onUseSkill={onUseSkill} onAnalyze={onAnalyze} onOpenAnalysis={onOpenAnalysis} />
    {tab === 'discover' && <Catalog preview={preview} target={target} clearPreview={() => setPreview(null)} />}
    {tab === 'create' && <CreatePage target={target} onTarget={setTarget} />}{tab === 'settings' && <Settings />}
  </div>
}
export const inject = ['slots', 'connection', 'sessions', 'conversation', 'uiWorkspace']
export const isPlugin = true
export function apply(ctx: any) {
  ctx.effect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const report = async () => {
      try { await api('client-ready', { revision: __SKILLNET_BUILD__ }, AbortSignal.timeout(5000)) }
      catch { if (!stopped) timer = setTimeout(report, 1500) }
    }
    void report()
    return () => { stopped = true; clearTimeout(timer) }
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    // Keep native diagnostics in the trace for dedicated graph conversations.
    style.textContent = '[data-conversation-session^="skillnet-analysis-"] [data-chat-flow-kind="turn-error"] { display: none; }'
    document.head.append(style)
    return () => style.remove()
  })
  void preloadWorkspace().catch(() => {})
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'skillnet', order: 10, label: 'SkillNet' }, ({ size }: { size?: number }) => <SkillNetIcon size={size} />))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'skillnet' }, () => <Panel onUseSkill={selection => openSkillDraft(ctx, selection)} onAnalyze={draft => openAnalysisDraft(ctx, draft)} onOpenAnalysis={sessionId => ctx.uiWorkspace.openSession(sessionId)} />))
}
