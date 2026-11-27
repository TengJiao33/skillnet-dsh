import React, { useEffect, useState } from 'react'
import { SkillNetIcon } from './SkillNetIcon'
import { LibraryWorkbench } from './workbench'
import type { ModelTarget } from './operations'
import { CreatePage } from './CreatePage'
import { preloadWorkspace } from './upstream/src/useWorkspace'
import { api } from './api'
import { openRouteDraft, openSkillDraft } from './chatDraft'
import type { SkillDraft, RouteDraft } from './chatDraft'
import { Catalog } from './pages'
import { Settings } from './Settings'
import css from 'skillnet:styles'
import logo from 'skillnet:logo'

declare const __SKILLNET_BUILD__: string

function Panel({ onUseSkill, onRouteDraft }: { onUseSkill: (selection: SkillDraft) => void, onRouteDraft: (selection: RouteDraft) => void }) {
  const [target, setTarget] = useState<ModelTarget>({})
  const [tab, setTab] = useState<'workbench' | 'discover' | 'create' | 'settings'>('workbench')
  const [preview, setPreview] = useState<any>(null)
  const [visitedCreate, setVisitedCreate] = useState(false)
  const [visitedSettings, setVisitedSettings] = useState(false)
  const openCreate = () => { setVisitedCreate(true); setTab('create') }
  useEffect(() => {
    const openPreview = (event: Event) => { setPreview((event as CustomEvent).detail) }
    const openLibrary = () => { setPreview(null); setTab('workbench') }
    window.addEventListener('skillnet-preview', openPreview)
    window.addEventListener('skillnet-open-library', openLibrary)
    return () => {
      window.removeEventListener('skillnet-preview', openPreview)
      window.removeEventListener('skillnet-open-library', openLibrary)
    }
  }, [])
  const navigation = <nav className="dsh-nav" aria-label="SkillNet"><button aria-current={tab === 'workbench' ? 'page' : undefined} onClick={() => setTab('workbench')}>我的技能库</button><button aria-current={tab === 'discover' ? 'page' : undefined} onClick={() => setTab('discover')}>发现</button><button aria-current={tab === 'create' ? 'page' : undefined} onClick={openCreate}>创建</button><button aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => { setVisitedSettings(true); setTab('settings') }}>设置</button></nav>
  return <div data-skillnet-build={__SKILLNET_BUILD__} className={`skillnet-shell ${tab !== 'workbench' ? 'dsh-other-page' : ''}`}><style>{css}</style>
    <LibraryWorkbench logo={logo} headerActions={navigation} active={tab === 'workbench'} target={target} onTarget={setTarget} onUseSkill={onUseSkill} onRouteDraft={onRouteDraft}
      onDiscover={() => setTab('discover')} onCreate={openCreate} />
    {(tab === 'discover' || preview) && <Catalog previewOnly={tab !== 'discover'} preview={preview} target={target} clearPreview={() => setPreview(null)} onUseSkill={onUseSkill} />}
    {visitedCreate && <CreatePage key="create" active={tab === 'create'} target={target} onTarget={setTarget} />}
    {visitedSettings && <Settings key="settings" active={tab === 'settings'} />}
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
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'skillnet' }, () => <Panel onUseSkill={selection => openSkillDraft(ctx, selection)} onRouteDraft={selection => openRouteDraft(ctx, selection)} />))
}
