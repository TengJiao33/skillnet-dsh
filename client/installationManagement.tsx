import React, { useEffect, useId, useRef, useState } from 'react'
import { api } from './api'

export type Installation = {
  id: string
  name: string
  path: string
  scope: 'user' | 'project' | 'managed'
  projectRoot?: string | null
  url?: string | null
  state: 'installed' | 'removed'
  exists: boolean
}

type Connection = { id: string, name: string, sourcePath: string }
type Inventory = { records: Installation[], libraries: Connection[], warnings: string[] }
type Dialog = { kind: 'remove', record: Installation } | { kind: 'removed' }

const changed = 'skillnet-library-changed'

export function notifyInstallationsChanged(connection?: Connection) {
  window.dispatchEvent(new CustomEvent(changed, { detail: connection }))
}

export function GraphUpdateLink({ connection, libraryName, onOpen }: { connection?: Connection, libraryName: string, onOpen?: () => void }) {
  return <div className="dsh-row">
    <span>可在「{libraryName}」建图或更新图谱。</span>
    {connection && <button type="button" onClick={() => {
      onOpen?.()
      window.dispatchEvent(new CustomEvent('skillnet-open-library', { detail: connection }))
    }}>打开技能库</button>}
  </div>
}

function comparablePath(value: string) {
  if (/^[a-z]:[\\/]|^[\\/]{2}/i.test(value)) return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return value.startsWith('/') ? value.replace(/\/+$/, '') : ''
}

// Local-library source rows identify the selected SKILL.md, while installation
// records identify the package directory. Match those paths, never skill names.
export function installationAt(records: Installation[], filePath?: string) {
  const path = filePath && comparablePath(filePath)
  if (!path) return undefined
  const marker = /^[a-z]:\/|^\/\//i.test(path) ? '/skill.md' : '/SKILL.md'
  const packagePath = path.endsWith(marker) ? path.slice(0, -marker.length) : path
  if (!packagePath) return undefined
  const matches = records.filter(record => record.state === 'installed' && record.exists && comparablePath(record.path) === packagePath)
  return matches.length === 1 ? matches[0] : undefined
}

export function installationsFrom(records: Installation[], url: string) {
  if (!url) return []
  return records.filter(record => record.url === url && installationAt(records, record.path) === record)
}

function installationConnection(record: Installation, libraries: Connection[]) {
  const path = comparablePath(record.path)
  const directory = path.slice(0, path.lastIndexOf('/'))
  if (!directory) return undefined
  return libraries.find(library => comparablePath(library.sourcePath) === directory)
}

export function installationLocation(record: Installation, libraries: Connection[]) {
  const connection = installationConnection(record, libraries)
  if (connection) return connection.name
  if (record.scope === 'user') return 'DSH 个人技能库'
  if (record.scope === 'project') return record.projectRoot?.split(/[\\/]/).filter(Boolean).at(-1) || '项目技能库'
  return record.path.split(/[\\/]/).filter(Boolean).at(-3) || '独立技能库'
}

export function useInstallationInventory(enabled = true) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    let reader: AbortController | undefined
    const refresh = () => {
      reader?.abort()
      const current = new AbortController()
      reader = current
      setLoading(true)
      setError('')
      void Promise.all([api('library', {}, current.signal), api('libraries', {}, current.signal)]).then(([result, libraries]) => {
        if (current.signal.aborted) return
        setInventory({ records: result.installed, libraries, warnings: result.warnings || [] })
      }).catch(cause => {
        if (current.signal.aborted) return
        setInventory(null)
        setError(cause.message)
      }).finally(() => { if (!current.signal.aborted) setLoading(false) })
    }
    refresh()
    window.addEventListener(changed, refresh)
    return () => { window.removeEventListener(changed, refresh); reader?.abort() }
  }, [enabled])
  return { inventory, loading, error }
}

export function useInstallationManagement(enabled: boolean) {
  const state = useInstallationInventory(enabled)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mutating = useRef(false)
  function open(value: Dialog | null) {
    if (mutating.current) return
    setDialog(value)
    setError('')
    setMessage('')
  }
  async function mutate(action: 'remove' | 'restore', record: Installation) {
    if (mutating.current) return
    mutating.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api(action, { id: record.id })
      setDialog({ kind: 'removed' })
      setMessage(action === 'remove' ? `已卸载 ${record.name}。` : `已恢复 ${record.name}。`)
      notifyInstallationsChanged(installationConnection(record, state.inventory?.libraries || []))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }
  return { inventory: state.inventory, loading: state.loading, readError: state.error, dialog, busy, message, error, open, mutate }
}

type Management = ReturnType<typeof useInstallationManagement>

export function RemoveInstalledSkill({ management, filePath }: { management: Management, filePath?: string }) {
  const record = installationAt(management.inventory?.records || [], filePath)
  return record && <button type="button" className="dsh-workbench-action" aria-haspopup="dialog"
    disabled={management.loading || management.busy} onClick={() => management.open({ kind: 'remove', record })}>卸载</button>
}

type UpdatePreview = {
  status: 'ready' | 'unchanged' | 'blocked'
  targetPath: string
  currentVersion?: string
  remoteVersion?: string
  changes: { path: string, kind: 'added' | 'modified' | 'removed' }[]
  currentSource?: string
  remoteSource?: string
  previewId?: string
  message?: string
}
type UpdatedInstallation = Installation & { backupPath?: string, connection?: Connection }
const updateKinds = { added: '新增', modified: '修改', removed: '移除' }

export function TrackInstalledSkillUpdate({ management, filePath }: { management: Management, filePath?: string }) {
  const inventory = management.inventory
  const record = installationAt(inventory?.records || [], filePath)
  if (!record?.url) return null
  return <InstalledSkillUpdate key={record.id} record={record} libraries={inventory?.libraries || []} />
}

export function InstalledSkillUpdate({ record, libraries, onUpdated }: {
  record: Installation, libraries: Connection[], onUpdated?: (record: UpdatedInstallation) => void | Promise<void>,
}) {
  const [visible, setVisible] = useState(false)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<UpdatePreview | null>(null)
  const [updated, setUpdated] = useState<UpdatedInstallation | null>(null)
  const reader = useRef<AbortController | undefined>(undefined)
  const writing = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    if (!visible) return
    const element = dialog.current
    element?.showModal()
    return () => { reader.current?.abort(); if (element?.open) element.close() }
  }, [visible])
  function close() {
    if (writing.current) return
    reader.current?.abort(); reader.current = undefined
    setVisible(false); setChecking(false)
  }
  async function check() {
    if (reader.current || writing.current) return
    const controller = new AbortController()
    reader.current = controller
    setVisible(true); setChecking(true); setError(''); setUpdated(null); setPreview(null)
    try {
      const result = await api('update-preview', { id: record.id }, controller.signal)
      if (!controller.signal.aborted) setPreview(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (reader.current === controller) { reader.current = undefined; setChecking(false) }
    }
  }
  async function apply() {
    if (writing.current || preview?.status !== 'ready' || !preview.previewId) return
    writing.current = true
    setApplying(true); setError('')
    try {
      const result: UpdatedInstallation = await api('update-apply', { id: record.id, previewId: preview.previewId })
      setUpdated(result); setPreview(null)
      notifyInstallationsChanged(result.connection || installationConnection(result, libraries))
      try { await onUpdated?.(result) }
      catch { setError('技能已更新，重新打开详情可查看新版。') }
    } catch (cause) {
      setPreview(null); setError(cause instanceof Error ? cause.message : String(cause))
    } finally { writing.current = false; setApplying(false) }
  }
  if (!record.url || record.state !== 'installed') return null
  const connection = updated?.connection || installationConnection(record, libraries)
  return <>
    <button type="button" className="dsh-workbench-action" aria-haspopup="dialog" onClick={() => void check()}>检查更新</button>
    {visible && <dialog ref={dialog} className="dsh-use-dialog dsh-package-dialog" aria-labelledby={heading} onClose={close}
      onCancel={event => { event.preventDefault(); close() }}>
      <header className="dsh-package-dialog-header"><h2 id={heading}>更新 {record.name}</h2><button type="button" disabled={applying} onClick={close}>关闭</button></header>
      <div className="dsh-package-dialog-body dsh-package">
        <p className="dsh-path">{preview?.targetPath || record.path}</p>
        {error && <p role="alert">{error}</p>}
        {checking && <p role="status">正在对比当前版本与原仓库…</p>}
        {preview?.status === 'unchanged' && <p role="status">{preview.message || '当前技能包与原仓库一致。'}</p>}
        {preview?.status === 'blocked' && <p role="alert">{preview.message || '当前技能包无法安全更新。'}</p>}
        {preview?.changes?.length ? <>
          <p>包版本 <code title={preview.currentVersion}>{preview.currentVersion?.slice(0, 12) || '未记录'}</code> → <code title={preview.remoteVersion}>{preview.remoteVersion?.slice(0, 12) || '未记录'}</code></p>
          <details><summary>文件变化（{preview.changes.length}）</summary><ul>{preview.changes.map(change => <li key={change.path}>{updateKinds[change.kind]} <code>{change.path}</code></li>)}</ul></details>
          {preview.currentSource !== undefined && preview.remoteSource !== undefined && <details><summary>对照技能说明</summary>
            <h3>当前版本</h3><pre>{preview.currentSource}</pre><h3>远端版本</h3><pre>{preview.remoteSource}</pre>
          </details>}
        </> : null}
        {preview?.status === 'ready' && preview.previewId && <button type="button" className="dsh-workbench-action" disabled={applying} onClick={() => void apply()}>{applying ? '正在更新…' : '备份并确认更新'}</button>}
        {!checking && !applying && !preview && !updated && <button type="button" onClick={() => void check()}>重新检查</button>}
        {updated && <>
          <p role="status">技能已更新。{updated.backupPath ? '已备份旧版本。' : ''}</p>
          {updated.backupPath && <details><summary>查看旧版备份路径</summary><code>{updated.backupPath}</code></details>}
          <GraphUpdateLink connection={connection} libraryName={installationLocation(record, libraries)} onOpen={close} />
        </>}
      </div>
    </dialog>}
  </>
}

export function RemovedInstallations({ management, onOpen }: { management: Management, onOpen: () => void }) {
  return <button type="button" aria-haspopup="dialog"
    onClick={() => { onOpen(); management.open({ kind: 'removed' }) }}>已移除技能</button>
}

export function InstallationManagementDialog({ management }: { management: Management }) {
  const { dialog, busy, inventory, loading, message, error, readError, open, mutate } = management
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const visible = dialog !== null
  useEffect(() => {
    if (!visible) return
    const element = ref.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [visible])
  if (!dialog) return null

  const removed = inventory?.records.filter(record => record.state === 'removed') || []
  return <dialog ref={ref} className="dsh-use-dialog" aria-labelledby={heading}
    onClose={() => open(null)} onCancel={event => { if (busy) event.preventDefault() }}>
    {dialog.kind === 'remove' ? <form onSubmit={event => { event.preventDefault(); void mutate('remove', dialog.record) }}>
      <h2 id={heading}>卸载 {dialog.record.name}</h2>
      <p><code>{dialog.record.path}</code></p>
      <p>卸载后可在「已移除技能」中恢复。</p>
      {error && <p role="alert">{error}</p>}
      <footer className="dsh-row">
        <button type="button" autoFocus disabled={busy} onClick={() => open(null)}>取消</button>
        <button type="submit" disabled={busy}>{busy ? '正在卸载…' : '确认卸载'}</button>
      </footer>
    </form> : <form onSubmit={event => event.preventDefault()}>
      <h2 id={heading}>已移除技能</h2>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {readError && <p role="alert">{readError}</p>}
      {loading ? <p role="status">正在读取安装记录…</p> : removed.length === 0 && !readError ? <p>暂无已移除技能。</p> :
        removed.map(record => <div key={record.id}>
          <div className="dsh-row"><strong>{record.name}</strong><span>{installationLocation(record, inventory?.libraries || [])}</span>
            <button type="button" disabled={busy} onClick={() => void mutate('restore', record)}>恢复</button>
          </div>
          <p><code>{record.path}</code></p>
        </div>)}
      <footer className="dsh-row"><button type="button" disabled={busy} onClick={() => open(null)}>关闭</button></footer>
    </form>}
  </dialog>
}
