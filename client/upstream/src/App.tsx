import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Dataset, Skill } from './data'
import type { LocalLibrary, LocalLibraryData } from './localLibrary'
import { ArrowRight, CircleHelp, GitBranch, Search, Upload, X } from 'lucide-react'
import { relationLabel } from './data'
import { SkillInspector, RelationInspector, SourceDialog } from './Inspectors'
import { useWorkspace } from './useWorkspace'
import { GraphView } from './GraphView'
import { firstConnectedSkill } from './selection'
import { Select } from '../../Select'
import './styles.css'

function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value)
}

export interface WorkbenchContext {
  library: LocalLibrary | undefined
  localData: LocalLibraryData | null
  dataset: Dataset
  selectedSkill: Skill | undefined
  selectSkill: (id: string) => void
  refresh: () => void
}

export default function App({ logoUrl = '/skillnet.png', headerActions, renderActions, renderOptions, renderGraphActions, renderGraphResult, renderSkillActions, renderSkillResult, compactControls = false }: {
  logoUrl?: string
  headerActions?: ReactNode
  renderActions?: (context: WorkbenchContext) => ReactNode
  renderOptions?: (context: WorkbenchContext) => ReactNode
  renderGraphActions?: (context: WorkbenchContext) => ReactNode
  renderGraphResult?: (context: WorkbenchContext) => ReactNode
  renderSkillActions?: (context: WorkbenchContext) => ReactNode
  renderSkillResult?: (context: WorkbenchContext) => ReactNode
  compactControls?: boolean
}) {
  const {
    dataset,
    importedDatasets,
    localLibraries,
    localData,
    collection,
    selectedSkillId,
    setSelectedSkillId,
    error,
    setError,
    loading,
    restoring,
    openLocalLibrary,
    connectLocalLibrary,
    createPersonalLibrary,
    updateIndex,
    forgetLocalLibrary,
    importFile,
    removeImport,
    changeLibrary,
  } = useWorkspace()
  const [sourcePathInput, setSourcePathInput] = useState('')
  const [indexPathInput, setIndexPathInput] = useState('')
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null)
  const [evidenceSource, setEvidenceSource] = useState<{ skill: Skill, line: number | null } | null>(null)
  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState<1 | 2>(1)
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph')
  const [relationQuery, setRelationQuery] = useState('')
  const [relationType, setRelationType] = useState<'all' | 'compose_with' | 'similar_to'>('all')
  const fileInput = useRef<HTMLInputElement>(null)
  const skillList = useRef<HTMLDivElement>(null)
  const graphCanvas = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSelectedRelationId(null)
    setQuery('')
    setRelationQuery('')
    setRelationType('all')
    setDepth(1)
    setSourcePathInput('')
    setIndexPathInput('')
  }, [dataset, collection])

  const addLocalLibrary = () => void connectLocalLibrary(sourcePathInput)
  const setLocalIndex = () => {
    if (!indexPathInput.trim()) {
      setError("请输入分析目录路径。")
      return
    }
    void updateIndex(indexPathInput.trim())
  }
  const useDefaultIndex = () => void updateIndex()
  const relationDataset = localData?.analysis || dataset
  const analyzedSkills = useMemo(() => new Map(localData?.analysis?.skills.map(skill => [skill.id, skill])), [localData?.analysis])
  const graphDataset = useMemo(
    () =>
      relationDataset.kind === 'snapshot' && relationType !== 'all'
        ? {
            ...relationDataset,
            relations: relationDataset.relations.filter((relation) => relation.type === relationType),
          }
        : relationDataset,
    [relationDataset, relationType],
  )
  const relationRows = useMemo(() => {
    const needle = relationQuery.trim().toLocaleLowerCase()
    if (!needle) return graphDataset.relations
    const byId = new Map(relationDataset.skills.map((skill) => [skill.id, skill]))
    return graphDataset.relations.filter((relation) => {
      const source = byId.get(relation.source)
      const target = byId.get(relation.target)
      return [
        relation.source,
        relation.target,
        source?.name,
        target?.name,
        ...relation.contexts.flatMap((context) => [context.scenario, context.explanation]),
      ].some((value) => value?.toLocaleLowerCase().includes(needle))
    })
  }, [graphDataset, relationDataset.skills, relationQuery])
  const analysisCounts = useMemo(
    () => ({
      compose: relationDataset.relations.filter((relation) => relation.type === 'compose_with').length,
      similar: relationDataset.relations.filter((relation) => relation.type === 'similar_to').length,
    }),
    [relationDataset],
  )
  const selectedSkill = useMemo(
    () => dataset.skills.find((skill) => skill.id === selectedSkillId) ?? dataset.skills[0],
    [dataset, selectedSkillId],
  )
  const selectedRelation = useMemo(
    () => relationDataset.relations.find((relation) => relation.id === selectedRelationId) ?? null,
    [relationDataset, selectedRelationId],
  )
  const graphFocus = useMemo(() => {
    const selected = graphDataset.skills.find(skill => skill.id === selectedSkillId)
    if (selected) return selected
    const fallback = firstConnectedSkill(graphDataset)
    return graphDataset.skills.find(skill => skill.id === fallback)
  }, [graphDataset, selectedSkillId])
  const related = useMemo(
    () =>
      relationDataset.relations.filter(
        (relation) =>
          relation.source === selectedSkill?.id || relation.target === selectedSkill?.id,
      ),
    [relationDataset, selectedSkill],
  )
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>()
    relationDataset.relations.forEach((relation) => {
      counts.set(relation.source, (counts.get(relation.source) ?? 0) + 1)
      counts.set(relation.target, (counts.get(relation.target) ?? 0) + 1)
    })
    return counts
  }, [relationDataset])
  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return dataset.skills.filter(
      (skill) =>
        !needle ||
        `${skill.name} ${skill.description} ${skill.id}`.toLocaleLowerCase().includes(needle),
    )
  }, [dataset, query])
  const displayedSkills = filteredSkills.slice(0, 200)
  const skillNames = useMemo(
    () => new Map(relationDataset.skills.map((skill) => [skill.id, skill.name])),
    [relationDataset.skills],
  )
  const relationSkillName = (id: string) => skillNames.get(id) ?? id
  useEffect(() => {
    const list = skillList.current
    if (!list) return
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>('.skill-row'))
    const row = rows.find((item) => item.dataset.skillId === selectedSkillId)
    if (row && rows[0]) list.scrollTop = Math.max(0, row.offsetTop - rows[0].offsetTop)
  }, [selectedSkillId, dataset, filteredSkills])
  useEffect(() => {
    const centerGraph = () => {
      const canvas = graphCanvas.current
      if (canvas && window.matchMedia('(max-width: 760px)').matches) {
        canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2
      }
    }
    centerGraph()
    window.addEventListener('resize', centerGraph)
    return () => window.removeEventListener('resize', centerGraph)
  }, [selectedSkillId, depth, dataset])

  const selectSkill = (id: string) => {
    if (!dataset.skills.some(skill => skill.id === id)) {
      const saved = relationDataset.skills.find(skill => skill.id === id)
      if (saved) setEvidenceSource({ skill: saved, line: null })
      return
    }
    setSelectedSkillId(id)
    setSelectedRelationId(null)
  }
  const selectRelation = (id: string) => {
    setSelectedRelationId(id)
  }
  const focusEvidence = (skillId: string, line: number) => {
    const saved = relationDataset.skills.find(skill => skill.id === skillId)
    if (saved) setEvidenceSource({ skill: saved, line })
  }
  const emptyLocalLibrary =
    collection.startsWith('local:') &&
    localData?.source.skills.length === 0 && !localData.analysis
  const showWorkbench = !restoring && collection !== 'personal' && !emptyLocalLibrary
  const currentLibrary = localLibraries.find((item) => item.id === collection)
  const workbenchContext: WorkbenchContext = { library: currentLibrary, localData, dataset, selectedSkill, selectSkill,
    refresh: () => { if (currentLibrary) void openLocalLibrary(currentLibrary) } }

  return (
    <div className={`app-shell${compactControls ? ' compact-workbench' : ''}`}>
      <header className="site-header">
        <div className="site-header-inner">
          <a href="https://skillnet.openkg.cn/" className="brand" aria-label="SkillNet 官网">
            <img src={logoUrl} alt="SkillNet" />
          </a>
          <div className="header-spacer" />
          {headerActions}
          <a
            className="header-link"
            href="https://github.com/zjunlp/SkillNet"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowRight size={14} />
          </a>
        </div>
      </header>

      <main>
        <fieldset className={`dataset-controls${compactControls && currentLibrary ? ' dsh-connected-controls' : ''}`} disabled={loading || restoring}>
          <section className="dataset-bar" aria-label="当前数据源">
            <label className="collection-control">
              技能库{' '}
              <Select
                value={currentLibrary?.id || ''}
                aria-label="技能库"
                disabled={loading || restoring}
                onValueChange={changeLibrary}
              >
                {localLibraries.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            <details className="local-library-menu">
                <summary>{compactControls ? '管理' : '目录管理'}</summary>
                <div>
                  {compactControls && <button type="button" onClick={() => fileInput.current?.click()}>导入图谱</button>}
                  {importedDatasets.length > 0 && (
                    <label>
                      已导入图谱
                      <Select aria-label="已导入图谱" value={collection.startsWith('imported:') ? collection : ''} onValueChange={changeLibrary}>
                        {importedDatasets.map((item) => <option key={item.id} value={item.id}>{item.dataset.title}</option>)}
                      </Select>
                    </label>
                  )}
                  {collection === 'personal' && <button type="button" onClick={() => void createPersonalLibrary()}>连接 DSH 个人技能库</button>}
                  {compactControls && collection.startsWith('imported:') && <button type="button" onClick={() => void removeImport()}>移除快照</button>}
                  <label>
                    技能目录路径
                    <input
                      value={sourcePathInput}
                      onChange={(event) => setSourcePathInput(event.target.value)}
                      placeholder="技能目录的绝对路径"
                    />
                  </label>
                  <button type="button" onClick={addLocalLibrary}>
                    连接技能库
                  </button>
                  {currentLibrary && (
                    <>
                      <p className="local-path">当前目录： {currentLibrary.sourcePath}</p>
                      <button type="button" onClick={() => void openLocalLibrary(currentLibrary)}>
                        刷新技能库
                      </button>
                      <label>
                        自定义分析目录
                        <input
                          value={indexPathInput}
                          onChange={(event) => setIndexPathInput(event.target.value)}
                          placeholder={currentLibrary.indexPath ?? "默认：.skillnet"}
                        />
                      </label>
                      {currentLibrary.indexPath && (
                        <p className="local-path">分析目录： {currentLibrary.indexPath}</p>
                      )}
                      <button type="button" onClick={() => void setLocalIndex()}>
                        连接分析目录
                      </button>
                      {currentLibrary.indexPath && (
                        <button type="button" onClick={() => void useDefaultIndex()}>
                          使用默认分析目录
                        </button>
                      )}
                      <button type="button" onClick={() => void forgetLocalLibrary()}>
                        断开技能库
                      </button>
                    </>
                  )}
                </div>
            </details>
            {renderOptions?.(workbenchContext)}
            <div className="dataset-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => fileInput.current?.click()}
                disabled={loading || restoring}
              >
                <Upload size={16} /> {loading ? "加载中…" : "导入图谱"}
              </button>
              {collection.startsWith('imported:') && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void removeImport()}
                  disabled={loading}
                >
                  移除快照
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                aria-label="选择 graph.json 图谱文件"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  void importFile(file)
                }}
              />
            </div>
            {!compactControls && collection !== 'personal' && !emptyLocalLibrary && (
              <div className="dataset-summary" aria-label="数据概况">
                {dataset.kind === 'source' ? (
                  <span>
                    <strong>{compactNumber(dataset.skills.length)}</strong> 项技能
                  </span>
                ) : (
                  <>
                    <span>
                      <strong>{compactNumber(analysisCounts.compose)}</strong> 项可组合关系
                    </span>
                    <span>
                      <strong>{compactNumber(analysisCounts.similar)}</strong> 项相似关系
                    </span>
                  </>
                )}
              </div>
            )}
          </section>
        </fieldset>
        {renderActions?.(workbenchContext)}
        {collection.startsWith('local:') &&
          localData?.analysis &&
          localData &&
          (localData.changedSkills > 0 ||
            localData.removedSkills > 0 ||
            localData.addedSkills > 0) && (
            <div className="stale-banner" role="status">
              已有图谱保留： {localData.addedSkills} 项尚未分析， {localData.changedSkills} 项已修改， {localData.removedSkills} 项已移除。点击“更新图谱”纳入变化。
            </div>
          )}
        {localData?.analysisError && (
          <div className="stale-banner" role="status">
            无法加载分析结果： {localData.analysisError} 仍可浏览当前技能文件。
          </div>
        )}
        {localData && localData.warnings.length > 0 && (
          <details className="stale-banner">
            <summary>{localData.warnings.length} 个技能文件无法读取</summary>
            {localData.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </details>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <CircleHelp size={18} /> {error}
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">
              <X size={17} />
            </button>
          </div>
        )}

        {!restoring && collection === 'personal' && (
          <section className="onboarding" aria-label="选择技能目录">
            <div className="onboarding-intro">
              <h1>{localLibraries.length ? '请选择技能目录' : '尚未连接技能目录'}</h1>
              <p>从上方选择已连接的技能目录，或在“管理”中连接 DSH 个人技能库及其他目录。</p>
            </div>
          </section>
        )}

        {!restoring && emptyLocalLibrary && (
          <fieldset className="dataset-controls" disabled={loading}>
            <section className="onboarding" aria-label="空技能库">
              <div className="onboarding-intro">
                <span>本地技能库</span>
                <h1>目录中还没有技能</h1>
                <p>
                  目录已连接。添加技能后，点击“刷新技能库”。
                </p>
              </div>
              <div className="onboarding-empty-path">
                <strong>技能目录</strong>
                <code>{currentLibrary?.sourcePath}</code>
              </div>
              <div className="onboarding-next">
                <h2>添加技能</h2>
                <p>从“发现”安装技能，或从“创建”生成草稿。添加后刷新技能库，再点击“建图 / 更新图谱”。</p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    if (currentLibrary) void openLocalLibrary(currentLibrary)
                  }}
                  disabled={loading}
                >
                  刷新技能库
                </button>
              </div>
            </section>
          </fieldset>
        )}

        {showWorkbench && (
          <>
            <section className="workbench-heading">
              <h1>技能与关系</h1>
            </section>

            <section className="workspace" aria-label="技能探索工作区">
              <aside className="skill-panel">
                <div className="panel-title">
                  <strong>技能列表</strong>
                  <span className="count-pill">{filteredSkills.length}</span>
                </div>
                <label className="search-box">
                  <Search size={17} />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索名称、能力或标识"
                    aria-label="搜索技能"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
                      <X size={14} />
                    </button>
                  )}
                </label>
                <div className="list-caption">
                  <span>
                    {query ? `${filteredSkills.length} 项匹配` : "全部技能"}
                    {filteredSkills.length > 200 &&
                      "（仅显示前 200 项，可搜索筛选）"}
                  </span>
                </div>
                <div className="skill-list" role="list" ref={skillList}>
                  {filteredSkills.length === 0 && (
                    <div className="no-results">
                      没有匹配的技能。
                      <button type="button" onClick={() => setQuery('')}>
                        清空搜索
                      </button>
                    </div>
                  )}
                  {displayedSkills.map((skill) => {
                    const active = skill.id === selectedSkill?.id
                    const count = relationCounts.get(skill.id) ?? 0
                    const analyzed = analyzedSkills.get(skill.id)
                    const status = localData?.analysis ? !analyzed ? '未分析' : analyzed.source !== skill.source ? '待更新' : '' : ''
                    return (
                      <button
                        type="button"
                        className={`skill-row ${active ? 'is-active' : ''}`}
                        key={skill.id}
                        data-skill-id={skill.id}
                        onClick={() => selectSkill(skill.id)}
                        aria-current={active ? 'true' : undefined}
                        aria-label={`${skill.name}${status ? `，${status}` : relationDataset.kind === 'snapshot' ? `，${count} 条关系` : ''}`}
                        title={skill.name}
                      >
                        <span className="skill-row-name">{skill.name}</span>
                        {status ? <span className="skill-row-count">{status}</span> : relationDataset.kind === 'snapshot' && (
                          <span className="skill-row-count" aria-hidden="true" title={`${count} 条关系`}>
                            <GitBranch size={14} /> {count}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </aside>

              <div className="graph-panel">
                <div className="panel-title graph-panel-title">
                  <strong>关系视图</strong>
                  {renderGraphActions?.(workbenchContext)}
                  {relationDataset.kind === 'snapshot' && (
                    <div className="graph-view-controls">
                      <div className="graph-tools">
                        <button
                          type="button"
                          className={viewMode === 'graph' ? 'is-on' : ''}
                          onClick={() => setViewMode('graph')}
                          aria-pressed={viewMode === 'graph'}
                        >
                          网图
                        </button>
                        <button
                          type="button"
                          className={viewMode === 'list' ? 'is-on' : ''}
                          onClick={() => setViewMode('list')}
                          aria-pressed={viewMode === 'list'}
                        >
                          列表
                        </button>
                      </div>
                      {viewMode === 'graph' && (
                        <div className="graph-tools">
                          <button
                            type="button"
                            className={depth === 1 ? 'is-on' : ''}
                            onClick={() => setDepth(1)}
                            aria-pressed={depth === 1}
                          >
                            一跳
                          </button>
                          <button
                            type="button"
                            className={depth === 2 ? 'is-on' : ''}
                            onClick={() => setDepth(2)}
                            aria-pressed={depth === 2}
                          >
                            两跳
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {renderGraphResult?.(workbenchContext)}
                {relationDataset.kind === 'snapshot' && (
                  <div className="graph-subtitle">
                    {viewMode === 'list' && <span>{relationRows.length} 条关系</span>}
                    <label className="graph-relation-control">
                      关系类型{' '}
                      <Select
                        aria-label="关系类型"
                        compact
                        value={relationType}
                        onValueChange={(value) => {
                          setRelationType(
                            value as 'all' | 'compose_with' | 'similar_to',
                          )
                          setSelectedRelationId(null)
                        }}
                      >
                        <option value="all">全部</option>
                        <option value="compose_with">可组合</option>
                        <option value="similar_to">相似</option>
                      </Select>
                    </label>
                    {viewMode === 'graph' && (
                      <span className="graph-limit">
                        {relationDataset.relations.length ? <>最多显示 {depth === 1 ? 10 : 16} 个相邻技能，全部关系可在列表中查看</> : '暂无已识别关系'}
                      </span>
                    )}
                  </div>
                )}
                {relationDataset.kind === 'source' ? (
                  <div className="graph-empty">
                    <strong>
                      {localData?.analysisStatus === 'error'
                        ? "分析结果不可用"
                        : "尚未建图"}
                    </strong>
                    <span>
                      点击关系区的“建图”生成技能关系。
                    </span>
                  </div>
                ) : viewMode === 'graph' ? (
                  <div className="graph-canvas" ref={graphCanvas}>
                    {graphFocus && (
                      <GraphView
                        dataset={graphDataset}
                        selectedSkillId={graphFocus.id}
                        selectedRelationId={selectedRelationId}
                        depth={depth}
                        onSelectSkill={selectSkill}
                        onSelectRelation={selectRelation}
                      />
                    )}
                  </div>
                ) : (
                  <div className="relation-list-view">
                    <label className="relation-search">
                      <Search size={16} />
                      <input
                        type="search"
                        value={relationQuery}
                        onChange={(event) => setRelationQuery(event.target.value)}
                        placeholder="搜索技能、场景或关系说明"
                        aria-label="搜索关系"
                      />
                    </label>
                    <div className="relation-list" role="list">
                      {relationRows.length === 0 ? (
                        <p className="relation-list-empty">没有匹配的关系。</p>
                      ) : (
                        relationRows.map((relation) => (
                          <button
                            type="button"
                            key={relation.id}
                            className={`relation-row ${selectedRelationId === relation.id ? 'is-active' : ''}`}
                            onClick={() => selectRelation(relation.id)}
                          >
                            <span className="relation-row-path">
                              <strong>{relationSkillName(relation.source)}</strong>
                              <span>{relation.type === 'similar_to' ? '↔' : '→'}</span>
                              <strong>{relationSkillName(relation.target)}</strong>
                            </span>
                            <span className="relation-row-detail">
                              <small className={`relation-badge ${relation.type}`}>
                                {relationLabel(relation.type)}
                              </small>
                              <span>
                                {relation.contexts[0]?.scenario ||
                                  relation.contexts[0]?.explanation}
                              </span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
                {relationDataset.kind === 'snapshot' && (
                  <div className="graph-footer">
                    <div className="legend">
                      <span>
                        <i className="legend-line compose" /> 可组合
                      </span>
                      <span>
                        <i className="legend-line similar" /> 相似
                      </span>
                    </div>
                    <span className="graph-desktop-help">
                      {viewMode === 'graph'
                        ? "点击节点或连线查看详情"
                        : "点击关系查看场景与证据"}
                    </span>
                    <span className="graph-mobile-help">
                      {viewMode === 'graph'
                        ? "滑动查看网图，点击节点或连线查看详情"
                        : "点击关系查看场景与证据"}
                    </span>
                  </div>
                )}
              </div>

              <aside className="detail-panel">
                <div className="panel-title">
                  <strong>{selectedRelation ? "关系详情" : "技能详情"}</strong>
                </div>
                {selectedRelation ? (
                  <RelationInspector
                    relation={selectedRelation}
                    dataset={relationDataset}
                    onFocus={focusEvidence}
                    onSelectSkill={selectSkill}
                  />
                ) : (
                  selectedSkill && (
                    <SkillInspector
                      actions={renderSkillActions?.(workbenchContext)}
                      result={renderSkillResult?.(workbenchContext)}
                      skill={selectedSkill}
                      dataset={dataset}
                      related={related}
                      focusedLine={null}
                      profileStale={Boolean(analyzedSkills.get(selectedSkill.id) && analyzedSkills.get(selectedSkill.id)?.source !== selectedSkill.source)}
                      onFocus={focusEvidence}
                      onSelectRelation={selectRelation}
                    />
                  )
                )}
              </aside>
            </section>
          </>
        )}
      </main>
      {evidenceSource && <SourceDialog skill={evidenceSource.skill} focusedLine={evidenceSource.line} historical onClose={() => setEvidenceSource(null)} />}
    </div>
  )
}
