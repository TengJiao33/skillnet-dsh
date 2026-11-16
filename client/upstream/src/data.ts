export type RelationType = 'compose_with' | 'similar_to'

export interface Skill {
  id: string
  name: string
  description: string
  source: string
  path: string
  profile?: Record<string, unknown>
}

export interface Evidence {
  skillId: string
  line: number
}

export interface RelationContext {
  scenario: string
  explanation: string
  conditions: string[]
  sourceEvidence: Evidence[]
  targetEvidence: Evidence[]
}

export interface Relation {
  id: string
  source: string
  target: string
  type: RelationType
  contexts: RelationContext[]
}

export interface Dataset {
  kind: 'source' | 'snapshot'
  title: string
  skills: Skill[]
  relations: Relation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonemptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name}缺失或不是文本。`)
  return value
}

function citationLines(value: unknown, name: string, skillId: string, maxLine: number): Evidence[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name}缺少证据行号。`)
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.line) ||
      (item.line as number) < 1 ||
      (item.line as number) > maxLine
    ) {
      throw new Error(`${name}[${index}] 的证据行号无效。`)
    }
    return { skillId, line: item.line as number }
  })
}

export function parseSnapshot(value: unknown, title: string): Dataset {
  if (!isRecord(value) || value.schema_version !== 1)
    throw new Error("仅支持 GraphSnapshot v1 格式的分析快照。")
  if (typeof value.embedding_model !== 'string' || typeof value.embedding_base_url !== 'string') {
    throw new Error("快照缺少模型元数据。")
  }
  if (!Array.isArray(value.skills) || !Array.isArray(value.relations)) {
    throw new Error("快照缺少技能或关系数组。")
  }
  if (value.skills.length === 0) throw new Error("快照中没有技能。")
  if (value.skills.length > 5000 || value.relations.length > 20000) {
    throw new Error("最多支持 5,000 项技能和 20,000 条关系，请导入较小的文件。")
  }
  const skills: Skill[] = value.skills.map((item: unknown, index: number) => {
    if (!isRecord(item)) throw new Error(`skills[${index}] 必须是对象。`)
    if (typeof item.content_hash !== 'string' || typeof item.path !== 'string') {
      throw new Error(`skills[${index}] 缺少源码元数据。`)
    }
    const source = nonemptyString(item.source, `skills[${index}].source`)
    const profile = validateProfile(item.profile, source, `skills[${index}].profile`)
    const capability = isRecord(profile.capability) ? profile.capability.text : undefined
    return {
      id: nonemptyString(item.skill_id, `skills[${index}].skill_id`),
      name: nonemptyString(item.name, `skills[${index}].name`),
      description: typeof capability === 'string' ? capability : '',
      source,
      path: item.path,
      profile,
    }
  })
  const byId = new Map(skills.map((skill) => [skill.id, skill]))
  const lineCounts = new Map(skills.map((skill) => [skill.id, sourceLines(skill.source).length]))
  const lineCount = (id: string) => lineCounts.get(id) ?? 0
  if (byId.size !== skills.length)
    throw new Error("快照中存在重复的技能标识。")
  const relations: Relation[] = value.relations.map((item: unknown, index: number) => {
    if (!isRecord(item)) throw new Error(`relations[${index}] 必须是对象。`)
    const source = nonemptyString(item.source, `relations[${index}].source`)
    const target = nonemptyString(item.target, `relations[${index}].target`)
    if (source === target) throw new Error(`relations[${index}] 不能将技能连接到自身。`)
    if (!byId.has(source) || !byId.has(target))
      throw new Error(`relations[${index}] 引用了不存在的技能。`)
    if (item.type !== 'compose_with' && item.type !== 'similar_to') {
      throw new Error(`relations[${index}] 的关系类型不受支持。`)
    }
    if (!Array.isArray(item.contexts) || item.contexts.length === 0) {
      throw new Error(`relations[${index}] 缺少关系场景。`)
    }
    const contexts: RelationContext[] = item.contexts.map(
      (context: unknown, contextIndex: number) => {
        if (!isRecord(context))
          throw new Error(`relations[${index}].contexts[${contextIndex}] 必须是对象。`)
        return {
          scenario: nonemptyString(
            context.scenario,
            `relations[${index}].contexts[${contextIndex}].scenario`,
          ),
          explanation: nonemptyString(
            context.explanation,
            `relations[${index}].contexts[${contextIndex}].explanation`,
          ),
          conditions: stringList(context.conditions),
          sourceEvidence: citationLines(
            context.source_evidence,
            'source_evidence',
            source,
            lineCount(source),
          ),
          targetEvidence: citationLines(
            context.target_evidence,
            'target_evidence',
            target,
            lineCount(target),
          ),
        }
      },
    )
    return { id: `relation-${index}`, source, target, type: item.type, contexts }
  })
  return {
    kind: 'snapshot',
    title,
    skills,
    relations,
  }
}

export function sourceLines(source: string): string[] {
  // Match Python str.splitlines(), which the SDK uses for evidence line numbers.
  const lines = source.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error("关系条件必须是文本。")
  return value as string[]
}

function validateProfile(value: unknown, source: string, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name}缺失。`)
  const maxLine = sourceLines(source).length
  const field = (entry: unknown) => {
    if (!isRecord(entry)) throw new Error(`${name}包含无效字段。`)
    nonemptyString(entry.text, name)
    citationLines(entry.evidence, name, '', maxLine)
  }
  const fields = (entries: unknown) => {
    if (!Array.isArray(entries)) throw new Error(`${name}缺少字段列表。`)
    entries.forEach(field)
  }
  field(value.capability)
  for (const key of ['when_to_use', 'inputs', 'outputs', 'constraints', 'tools']) fields(value[key])
  if (!Array.isArray(value.scenarios)) throw new Error(`${name}缺少适用场景。`)
  value.scenarios.forEach((scenario) => {
    if (!isRecord(scenario)) throw new Error(`${name}包含无效场景。`)
    nonemptyString(scenario.name, name)
    fields(scenario.before)
    fields(scenario.after)
  })
  return value
}

export function relationLabel(type: RelationType): string {
  switch (type) {
    case 'compose_with':
      return "可组合"
    case 'similar_to':
      return "相似"
  }
}

export function skillShortName(skill: Skill): string {
  return skill.name.replaceAll('-', ' ')
}
