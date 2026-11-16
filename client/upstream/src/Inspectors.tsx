import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowRight, FileText, Maximize2, X } from 'lucide-react'
import { relationLabel, sourceLines } from './data'
import type { Dataset, Evidence, Relation, Skill } from './data'

function getProfileItems(
  profile: Record<string, unknown> | undefined,
  key: string,
): Array<{ text: string; lines: number[] }> {
  const entries = key === 'capability' ? [profile?.capability] : profile?.[key]
  if (!Array.isArray(entries)) return []
  return entries.flatMap((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('text' in item) ||
      typeof item.text !== 'string'
    )
      return []
    const evidence = 'evidence' in item && Array.isArray(item.evidence) ? item.evidence : []
    const lines = (evidence as unknown[]).flatMap((citation: unknown) =>
      typeof citation === 'object' &&
      citation !== null &&
      'line' in citation &&
      typeof citation.line === 'number'
        ? [citation.line]
        : [],
    )
    return [{ text: item.text, lines }]
  })
}

function SourceViewer({ skill, focusedLine }: { skill: Skill; focusedLine: number | null }) {
  const lines = useMemo(() => sourceLines(skill.source), [skill.source])
  const lineId = useId()
  useEffect(() => {
    if (focusedLine === null) return
    const timer = window.setTimeout(
      () =>
        document
          .getElementById(`${lineId}-source-line-${focusedLine}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      60,
    )
    return () => window.clearTimeout(timer)
  }, [skill.id, focusedLine, lineId])
  return (
    <div className="source-frame" tabIndex={0} aria-label={`${skill.name} 的 SKILL.md 源码`}>
      {lines.map((line, index) => (
        <div
          id={`${lineId}-source-line-${index + 1}`}
          key={`${skill.id}-${index}`}
          className={`source-line ${focusedLine === index + 1 ? 'is-highlighted' : ''}`}
        >
          <span className="source-number">{index + 1}</span>
          <span className="source-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function SourceDialog({ skill, focusedLine, onClose, historical = false }: {
  skill: Skill
  focusedLine: number | null
  onClose: () => void
  historical?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  return (
    <dialog className="source-dialog" ref={dialog} aria-labelledby={titleId} onClose={onClose}>
      <header className="source-dialog-header">
        <div className="source-dialog-heading">
          <h2 id={titleId}>{skill.name}</h2>
          <span>{historical ? '分析时的 SKILL.md' : 'SKILL.md 源码'} / {sourceLines(skill.source).length} 行</span>
        </div>
        <button type="button" className="source-dialog-close" aria-label="关闭源码阅读窗口" title="关闭（Esc）" autoFocus onClick={() => dialog.current?.close()}>
          <X size={20} />
        </button>
      </header>
      <SourceViewer skill={skill} focusedLine={focusedLine} />
    </dialog>
  )
}

function EvidenceLink({
  evidence,
  onFocus,
}: {
  evidence: Evidence
  onFocus: (skillId: string, line: number) => void
}) {
  return (
    <button
      type="button"
      className="evidence-link"
      title={`查看 ${evidence.skillId} 的源码第 ${evidence.line} 行`}
      onClick={() => onFocus(evidence.skillId, evidence.line)}
    >
      <FileText size={14} /> {evidence.skillId.split('::').at(-1)} / L{evidence.line}{' '}
      <ArrowRight size={13} />
    </button>
  )
}

export function RelationInspector({
  relation,
  dataset,
  onFocus,
  onSelectSkill,
}: {
  relation: Relation
  dataset: Dataset
  onFocus: (skillId: string, line: number) => void
  onSelectSkill: (id: string) => void
}) {
  const byId = new Map(dataset.skills.map((skill) => [skill.id, skill]))
  return (
    <div className="inspector-content">
      <div className="relation-provenance">
        <div className={`relation-badge ${relation.type}`}>{relationLabel(relation.type)}</div>
        <span>模型分析</span>
      </div>
      <div className="relation-path">
        <button type="button" onClick={() => onSelectSkill(relation.source)}>
          {byId.get(relation.source)?.name ?? relation.source}
        </button>
        <span>{relation.type === 'similar_to' ? '↔' : '→'}</span>
        <button type="button" onClick={() => onSelectSkill(relation.target)}>
          {byId.get(relation.target)?.name ?? relation.target}
        </button>
      </div>
      {relation.contexts.map((context, index) => (
        <section className="inspector-section" key={index}>
          <div className="section-index">场景 {String(index + 1).padStart(2, '0')}</div>
          <h3>{context.scenario}</h3>
          <p>{context.explanation}</p>
          {context.conditions.length > 0 && (
            <div className="condition-list">
              {context.conditions.map((condition, conditionIndex) => (
                <span key={conditionIndex}>{condition}</span>
              ))}
            </div>
          )}
          <div className="evidence-group">
            <span className="field-label">来源技能证据</span>
            {context.sourceEvidence.map((evidence, evidenceIndex) => (
              <EvidenceLink key={evidenceIndex} evidence={evidence} onFocus={onFocus} />
            ))}
          </div>
          {context.targetEvidence.length > 0 && (
            <div className="evidence-group">
              <span className="field-label">目标技能证据</span>
              {context.targetEvidence.map((evidence, evidenceIndex) => (
                <EvidenceLink key={evidenceIndex} evidence={evidence} onFocus={onFocus} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

export function SkillInspector({
  actions,
  result,
  skill,
  dataset,
  related,
  focusedLine,
  onFocus,
  onSelectRelation,
  profileStale = false,
}: {
  actions?: ReactNode
  result?: ReactNode
  skill: Skill
  dataset: Dataset
  related: Relation[]
  focusedLine: number | null
  onFocus: (skillId: string, line: number) => void
  onSelectRelation: (id: string) => void
  profileStale?: boolean
}) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const groups = [
    ['capability', '能力概述'],
    ['when_to_use', "适用场景"],
    ['inputs', "输入"],
    ['outputs', "输出"],
    ['constraints', "约束"],
    ['tools', "工具"],
  ] as const
  const byId = new Map(dataset.skills.map((item) => [item.id, item]))
  return (
    <div className="inspector-content">
      <div className="skill-detail-heading">
        <h2 className="skill-detail-name">{skill.name}</h2>
        {actions}
      </div>
      <div className="skill-path">
        <FileText size={14} /> {skill.path || skill.id}
      </div>
      <div className="capability-card">
        <div className="field-label">
          描述
        </div>
        <p>{skill.description || "暂无描述，可查看下方源码。"}</p>
      </div>
      {skill.profile && <h3 className="profile-source-label skill-section-label">技能画像{profileStale && <span className="profile-stale">待更新</span>}</h3>}
      {skill.profile && (
        <div className="profile-groups">
          {groups.map(([key, title]) => {
            const items = getProfileItems(skill.profile, key)
            if (items.length === 0) return null
            return (
              <section className="profile-group" key={key}>
                <h4>{title}</h4>
                {items.map((item, index) => (
                  <div className="profile-item" key={index}>
                    <span>{item.text}</span>
                    {item.lines.map((line) => (
                      <button key={line} type="button" title={`查看源码第 ${line} 行`} onClick={() => onFocus(skill.id, line)}>
                        L{line}
                      </button>
                    ))}
                  </div>
                ))}
              </section>
            )
          })}
        </div>
      )}
      {result}
      <section className="inspector-section related-section">
        <div className="section-heading">
          <h3 className="skill-section-label">相关关系</h3>
          <span>{related.length}</span>
        </div>
        {related.length === 0 ? (
          <p className="muted">当前数据中没有记录该技能的关系。</p>
        ) : (
          <div className="related-list">
            {related.map((relation) => {
              const otherId = relation.source === skill.id ? relation.target : relation.source
              const other = byId.get(otherId)
              return (
                <button
                  type="button"
                  key={relation.id}
                  onClick={() => onSelectRelation(relation.id)}
                >
                  <span className={`small-dot ${relation.type}`} />
                  <span>{other?.name ?? otherId}</span>
                  <small>{relationLabel(relation.type)}</small>
                  <ArrowDownRight size={14} />
                </button>
              )
            })}
          </div>
        )}
      </section>
      <section className="inspector-section source-section">
        <div className="section-heading">
          <div className="source-heading-title">
            <h3 className="skill-section-label">源码</h3>
            <button type="button" className="source-expand" aria-label="放大阅读 SKILL.md 源码" title="放大阅读" onClick={() => setSourceOpen(true)}>
              <Maximize2 size={16} />
            </button>
          </div>
          <span>{sourceLines(skill.source).length} 行</span>
        </div>
        <SourceViewer skill={skill} focusedLine={focusedLine} />
      </section>
      {sourceOpen && <SourceDialog skill={skill} focusedLine={focusedLine} onClose={() => setSourceOpen(false)} />}
    </div>
  )
}
