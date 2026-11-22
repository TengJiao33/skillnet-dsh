import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, FolderGit2, Info, ListChecks, SlidersHorizontal, Star } from 'lucide-react'
import { api } from './api'
import { Select } from './Select'
const evaluationNames: Record<string, string> = { safety: '安全性', completeness: '完整性', executability: '可执行性', cost_awareness: '成本意识', maintainability: '可维护性' }
const levels: Record<string, string> = { Good: '良好', Average: '一般', Poor: '较弱' }
const evaluationText = (value: any) => levels[value?.level || value] || value?.level || String(value)
type InstallTarget = { id: string, name: string }

function packageReadFailure(error: any) {
  const message = String(error?.message || error)
  const status = message.match(/GitHub API Error \[(\d+)\]/i)?.[1]
  if (status === '403') return 'GitHub 暂时拒绝读取技能包（403）。请稍后重试；若持续失败，请检查仓库访问权限或 GitHub 请求额度。'
  if (status === '404') return '技能来源路径或版本不存在（404），请检查仓库中的技能文件。'
  if (status === '429') return 'GitHub 请求过于频繁，请稍后重试。'
  if (status === '0' || /timed out|timeout/i.test(message)) return '读取技能包超时或连接失败，请检查网络后重试。'
  if (status) return `读取 GitHub 技能包失败（${status}），请稍后重试。`
  return message
}

function repositoryUrl(source: string) {
  try {
    const url = new URL(source)
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    if (url.protocol === 'https:' && url.hostname === 'github.com' && owner && repo) return `https://github.com/${owner}/${repo}`
  } catch {}
  return undefined
}

let initialCatalog: any = null
let initialCatalogExpiresAt = 0
let initialCatalogRequest: Promise<any> | null = null
function readInitialCatalog() {
  if (initialCatalog && Date.now() < initialCatalogExpiresAt) return Promise.resolve(initialCatalog)
  if (!initialCatalogRequest) initialCatalogRequest = api('discover').then(value => { initialCatalog = value; initialCatalogExpiresAt = Date.now() + 300_000; return value }).finally(() => { initialCatalogRequest = null })
  return initialCatalogRequest
}

function PackageDialog({ name, pending, onClose, children }: { name: string, pending: boolean, onClose: () => void, children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="dsh-use-dialog dsh-package-dialog" aria-labelledby="dsh-package-heading" onClose={onClose} onCancel={event => { if (pending) event.preventDefault() }}>
    <header className="dsh-package-dialog-header"><h2 id="dsh-package-heading">{name}</h2><button type="button" autoFocus disabled={pending} onClick={onClose}>关闭</button></header>
    <div className="dsh-package-dialog-body">{children}</div>
  </dialog>
}

export function Catalog({ preview, target, clearPreview }: { preview: any, target: { sessionId?: string }, clearPreview: () => void }) {
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState('auto')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('stars')
  const [stars, setStars] = useState(0)
  const [threshold, setThreshold] = useState(0.8)
  const [limit, setLimit] = useState(20)
  const [result, setResult] = useState<any>(() => Date.now() < initialCatalogExpiresAt ? initialCatalog : null)
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState('')
  const [library, setLibrary] = useState<any>(null)
  const [detail, setDetail] = useState<any>(preview)
  const [packageOpen, setPackageOpen] = useState(Boolean(preview))
  const [packageName, setPackageName] = useState(preview?.name || '')
  const [packageLoading, setPackageLoading] = useState(false)
  const [packageError, setPackageError] = useState('')
  const [packageAction, setPackageAction] = useState<'view' | 'download'>(preview ? 'download' : 'view')
  const [file, setFile] = useState<any>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [installTargets, setInstallTargets] = useState<{ previewId: string, targets: InstallTarget[], error?: string } | null>(null)
  const [installTarget, setInstallTarget] = useState('')
  const searchController = useRef<AbortController | null>(null)
  const packageController = useRef<AbortController | null>(null)
  const resultVersion = useRef(0)
  useEffect(() => () => searchController.current?.abort(), [])
  useEffect(() => () => { packageController.current?.abort(); packageController.current = null }, [])
  useEffect(() => {
    if (!result) void browse()
    return () => { resultVersion.current++ }
  }, [])
  async function refresh() { setLibrary(await api('library')) }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (preview) { packageController.current?.abort(); packageController.current = null; setDetail(preview); setPackageName(preview.name); setPackageError(''); setPackageLoading(false); setPackageAction('download'); setPackageOpen(true) }
  }, [preview])
  const previewId = detail?.validation.valid ? detail.previewId : null
  const forConversation = Boolean(preview?.installToPersonal)
  useEffect(() => {
    setInstallTargets(null)
    if (!previewId) return
    const controller = new AbortController()
    void api('install-targets', {}, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setInstallTargets({ previewId, targets: forConversation ? value.targets.filter((item: InstallTarget) => !item.id) : value.targets })
      setInstallTarget(forConversation ? '' : value.currentId)
    }).catch(cause => {
      if (!controller.signal.aborted) setInstallTargets({ previewId, targets: [], error: cause.message })
    })
    return () => controller.abort()
  }, [previewId, forConversation])
  async function act(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work() } catch (e: any) { setError(e.message) } finally { setBusy(false) } }
  async function browse(page = 1) {
    const version = ++resultVersion.current
    setBrowseBusy(true); setBrowseError('')
    try {
      const value = await (page === 1 ? readInitialCatalog() : api('discover', { page }))
      if (version === resultVersion.current) setResult(value)
    } catch (e: any) { if (version === resultVersion.current) setBrowseError(e.message) }
    finally { if (version === resultVersion.current) setBrowseBusy(false) }
  }
  async function search(page = 1) {
    await act(async () => {
      const version = ++resultVersion.current
      setBrowseBusy(false); setBrowseError('')
      const controller = new AbortController(); searchController.current = controller
      try { setResult(null); const value = await api('search', { q: query, mode: searchMode, sort_by: sort, min_stars: stars, category, threshold, page, limit, includeCandidates: true, sessionId: target.sessionId }, controller.signal); if (!controller.signal.aborted && version === resultVersion.current) setResult(value) }
      finally { if (searchController.current === controller) searchController.current = null }
    })
  }
  function searchPage(page: number) {
    if (result?.mode === 'auto' && Array.isArray(result.candidates)) {
      setResult({ ...result, page, skills: result.candidates.slice((page - 1) * result.limit, page * result.limit) })
    } else void search(page)
  }
  async function openPackage(name: string, load: (signal: AbortSignal) => Promise<any>, action: 'view' | 'download' = 'view') {
    if (busy || packageController.current) return
    const controller = new AbortController()
    packageController.current = controller
    setPackageName(name); setPackageAction(action); setPackageOpen(true); setPackageLoading(true); setPackageError(''); setDetail(null); setFile(null)
    await act(async () => {
      try {
        const value = await load(controller.signal)
        if (!controller.signal.aborted && packageController.current === controller) setDetail(value)
      } catch (e: any) { if (!controller.signal.aborted) setPackageError(packageReadFailure(e)) }
      finally { if (packageController.current === controller) { packageController.current = null; setPackageLoading(false) } }
    })
  }
  function closePackage() {
    packageController.current?.abort(); packageController.current = null
    setPackageOpen(false); setPackageLoading(false); setDetail(null); setFile(null); clearPreview()
  }
  function inspect(skill: any, action: 'view' | 'download' = 'view') {
    const found = library?.installed.find((x: any) => x.state === 'installed' && x.url === skill.skill_url)
    return openPackage(skill.skill_name, signal => found && action === 'view' ? api('installed', { id: found.id }, signal) : api('inspect', { url: skill.skill_url, catalog: skill }, signal), action)
  }
  const native = (value: any) => value?.effective ? value.modelInvocable || value.userInvocable ? 'DSH 可调用' : '已识别，当前预设禁用调用' : value?.available ? '存在同名覆盖' : 'DSH 尚未识别'
  const targetOptions = installTargets?.previewId === previewId ? installTargets : null
  const destination = targetOptions?.targets.find(item => item.id === installTarget)
  async function install() {
    if (!destination || !previewId) return
    await act(async () => {
      const args = destination.id ? { previewId, libraryId: destination.id } : { previewId, scope: 'user' }
      const value = await api('install', args)
      setDetail({ ...detail, previewId: null, installationId: value.id, native: value.native, record: value })
      setNotice(`已安装到「${value.libraryName}」。${value.connectionWarning ? '技能库刷新失败：' + value.connectionWarning : ''}`)
      window.dispatchEvent(new CustomEvent('skillnet-library-changed', { detail: value.connection }))
      await refresh()
    })
  }
  const savedToManaged = detail?.record?.scope === 'managed' && !detail.native?.effective
  const installation = detail && (detail.previewId ? <div className="dsh-package-install">
    {!detail.validation.valid ? <p>此技能包无法安装。</p> :
      targetOptions?.error ? <p role="alert">{targetOptions.error}</p> :
      targetOptions ? <label className="dsh-install-target"><span>安装到</span>
        {targetOptions.targets.length > 1 ? <Select aria-label="安装到" value={installTarget} disabled={busy} onValueChange={setInstallTarget}>
          {targetOptions.targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select> : <strong>{destination?.name}</strong>}
      </label> : <p role="status">正在读取技能库…</p>}
    <button type="button" className="primary-button" disabled={busy || !destination || !detail.validation.valid} onClick={() => void install()}>确认安装</button>
  </div> : !savedToManaged && <p>{native(detail.native)}</p>)
  return <main className="dsh-page dsh-discover-page"><h1>发现下一项能力</h1>
    <form className="dsh-search" onSubmit={e => { e.preventDefault(); void search() }}><input aria-label="搜索技能" placeholder="搜索技能或描述任务" required value={query} onChange={e => setQuery(e.target.value)} /><button className="primary-button" disabled={busy}>搜索</button>{busy && searchController.current && <button type="button" onClick={() => searchController.current?.abort()}>取消检索</button>}
      <details className="dsh-search-options">
        <summary><SlidersHorizontal size={14} aria-hidden="true" /><span>筛选</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="dsh-filters">
          <label className="dsh-filter-mode"><span>检索方式</span><Select compact aria-label="检索方式" value={searchMode} onValueChange={value => { setSearchMode(value); if (value !== 'keyword' && sort === 'recent') setSort('stars') }}><option value="auto">智能检索</option><option value="keyword">关键词</option><option value="vector">语义</option></Select></label>
          <label><span>分类</span><input aria-label="技能分类" value={category} onChange={e => setCategory(e.target.value)} placeholder="全部" /></label>
          <label><span>排序</span><Select compact aria-label="排序" title={sort === 'stars' ? '按来源仓库星标从高到低排序' : sort === 'recent' ? '按最近更新排序' : '相关性优先，同等匹配优先仓库星标'} value={sort} onValueChange={setSort}><option value="stars">星标</option><option value="relevance">相关度</option>{searchMode === 'keyword' && <option value="recent">最近</option>}</Select></label>
          <label className="dsh-filter-number"><span>最低星标</span><input aria-label="最低星标" type="number" min="0" value={stars} onChange={e => setStars(Number(e.target.value))} /></label>
          <label className="dsh-filter-number"><span>每页显示</span><Select compact aria-label="每页显示" value={limit} onValueChange={value => setLimit(Number(value))}>{[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}</Select></label>
          {searchMode === 'vector' && <label className="dsh-filter-number"><span>相似度阈值</span><input aria-label="相似度阈值" type="number" min="0" max="1" step="0.05" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>}
        </div>
      </details>
    </form>
    {browseBusy && !result && <><p role="status">正在读取 SkillNet 技能…</p><div className="dsh-catalog" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div className="dsh-card dsh-catalog-placeholder" key={i}><span /><span /><span /></div>)}</div></>}
    {browseError && <div className="error-banner" role="alert">{browseError} <button disabled={browseBusy} onClick={() => void browse(result?.page || 1)}>重试</button></div>}
    {result?.warnings?.length > 0 && <div className="dsh-search-feedback" role="status"><Info size={16} aria-hidden="true" /><span>{result.warnings.join(' ')}{result.skills.length > 0 && ' 已保留已获取的匹配结果。'}</span></div>}
    {result && <>
      <div className="dsh-row dsh-catalog-heading"><h2>{result.browse ? '浏览技能' : '搜索结果'}</h2>{result.browse && <span>按来源仓库星标排序</span>}<span>{Array.isArray(result.candidates) ? `已召回 ${result.candidateCount} 项 · 第 ${result.page} 页 · 当前 ${result.skills.length} 项` : `${result.mode === 'keyword' ? `第 ${result.page} 页 / ` : ''}${result.skills.length} 项`}</span>{!result.browse && <button disabled={busy || browseBusy} onClick={() => { setQuery(''); void browse() }}>返回浏览</button>}{(result.mode === 'keyword' || Array.isArray(result.candidates)) && <><button disabled={busy || browseBusy || result.page <= 1} onClick={() => result.browse ? void browse(result.page - 1) : searchPage(result.page - 1)}>上一页</button><button disabled={busy || browseBusy || (Array.isArray(result.candidates) ? result.page * result.limit >= result.candidates.length : !(result.hasMore ?? result.skills.length >= result.limit))} onClick={() => result.browse ? void browse(result.page + 1) : searchPage(result.page + 1)}>下一页</button></>}</div>
      {!result.skills.length && <p role="status">{result.hasMore ? '本页暂无可用技能，可继续查看下一页。' : result.browse ? '暂无可浏览的技能，可输入任务搜索。' : '没有找到匹配的技能，试试调整搜索内容或筛选条件。'}</p>}
      <div className="dsh-catalog">{result.skills.map((skill: any) => {
        const repository = repositoryUrl(skill.skill_url)
        const source = <><FolderGit2 size={15} aria-hidden="true" /><span>{skill.repo_name || '来源仓库'}</span></>
        return <article className="dsh-card" key={skill.skill_url}>
        <header className="dsh-catalog-card-heading"><h2>{skill.skill_name}</h2></header>
        <p className="dsh-catalog-description">{skill.skill_description}</p>
        <div className="dsh-catalog-meta">{repository ? <a className="dsh-catalog-repository" href={repository} target="_blank" rel="noreferrer" title={skill.repo_name}>{source}</a> : <span className="dsh-catalog-repository" title={skill.repo_name}>{source}</span>}<span className="dsh-catalog-stars" title="来源仓库星标"><Star size={15} fill="currentColor" strokeWidth={1.6} aria-hidden="true" />{skill.stars}</span></div>
        <footer className="dsh-catalog-footer">
          {Object.keys(skill.evaluation || {}).some(key => evaluationNames[key]) && <details className="dsh-catalog-assessment">
            <summary><ListChecks size={14} aria-hidden="true" /><span>目录已有评估</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <p className="dsh-catalog-assessment-source">来自 SkillNet 目录</p>
            <div className="dsh-evaluation">{Object.entries(skill.evaluation).filter(([key]) => evaluationNames[key]).map(([key, value]) => <span key={key}>{evaluationNames[key]} {evaluationText(value)}</span>)}</div>
          </details>}
          <div className="dsh-catalog-actions"><button type="button" disabled={busy} onClick={() => void inspect(skill)}>查看</button><button type="button" className="dsh-catalog-download" disabled={busy} onClick={() => void inspect(skill, 'download')}>下载</button></div>
        </footer>
      </article>})}</div>
    </>}
    {!packageOpen && <>{busy && <p role="status">正在处理…</p>}{error && <p className="error-banner" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</>}{library?.warnings?.map((warning: string) => <p key={warning} role="status">{warning}</p>)}
    {packageOpen && <PackageDialog name={detail?.name || packageName} pending={busy && !packageLoading} onClose={closePackage}>
      {packageLoading && <p role="status">正在读取技能包…</p>}
      {packageError && <p className="error-banner" role="alert">{packageError}</p>}
      {busy && !packageLoading && <p role="status">正在处理…</p>}{error && <p className="error-banner" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {detail && <section className="dsh-package" aria-label="技能包内容">{detail.url && <a href={detail.url} target="_blank" rel="noreferrer">原仓库 ↗</a>}
      {packageAction === 'download' && installation}
      {[...detail.validation.errors, ...detail.validation.warnings].map((message: string, i: number) => <p role="status" key={i}>{message}</p>)}
      <pre>{detail.source}</pre><details><summary>技能包文件</summary>{detail.files.map((name: string) => <button key={name} disabled={busy} onClick={() => void act(async () => { setFile(await api('file', { previewId: detail.previewId, id: detail.installationId, file: name })) })}>{name}</button>)}{file && <><h3>{file.file}</h3><pre>{file.binary ? '二进制文件' : file.text}</pre>{file.truncated && <p>仅显示前 256 KiB。</p>}</>}</details>
      {detail.catalog?.evaluation && <details><summary>目录已有评估</summary>{Object.entries(detail.catalog.evaluation).filter(([key]) => evaluationNames[key]).map(([key, value]: [string, any]) => <section key={key}><h3>{evaluationNames[key]} {evaluationText(value)}</h3><p>{value.reason}</p></section>)}</details>}
      {packageAction === 'view' && installation}
    </section>}
    </PackageDialog>}
  </main>
}
