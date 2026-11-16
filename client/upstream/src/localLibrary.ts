import { parseSnapshot } from './data'
import type { Dataset } from './data'

export interface LocalLibrary {
  id: string
  name: string
  sourcePath: string
  indexPath?: string
}

export interface LocalLibraryData {
  connection?: LocalLibrary
  source: Dataset
  analysis: Dataset | null
  analysisRevision?: string | null
  analysisMode?: 'model' | 'vector' | null
  analysisStatus: 'missing' | 'ready' | 'error'
  analysisError: string | null
  warnings: string[]
  changedSkills: number
  removedSkills: number
  addedSkills: number
}

interface LocalResponse extends Omit<LocalLibraryData, 'analysis'> {
  name: string
  sourcePath: string
  graph: unknown | null
}

export function unifiedLibrary(data: LocalLibraryData): Dataset {
  const analyzed = new Map(data.analysis?.skills.map(skill => [skill.id, skill]))
  // Read current files and attach only the saved profile. Evidence opens the
  // untouched snapshot separately, never the current file's shifted lines.
  return { ...data.source, skills: data.source.skills.map(skill => {
    const profile = analyzed.get(skill.id)?.profile
    return profile ? { ...skill, profile } : skill
  }) }
}

async function localRequest(body: object, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch((body as { action?: string }).action === 'create-default' ? 'api/skillnet/workspace-create' : 'api/skillnet/workspace-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('无法连接 SkillNet 插件后端。')
  }
  const value = await response.json()
  if (!response.ok || !value.ok)
    throw new Error(value.error?.message || "无法读取本地技能库。")
  return value.data
}

export async function initialLibraryPath(): Promise<string | null> {
  try {
    const response = await fetch('api/skillnet/workspace-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
      return null
    const value = (await response.json()).data
    return typeof value.sourcePath === 'string' ? value.sourcePath : null
  } catch {
    return null
  }
}

export async function createDefaultLibrary(): Promise<string> {
  const value = (await localRequest({ action: 'create-default' })) as { sourcePath: string }
  return value.sourcePath
}

export async function readLocalLibrary(
  library: LocalLibrary,
  signal?: AbortSignal,
  analysisLocation?: { indexPath: string | null },
): Promise<LocalLibraryData> {
  const value = (await localRequest(
    // Normal reads restore the backend connection. Only a user changing the
    // analysis location should submit and validate a new index path.
    { sourcePath: library.sourcePath, ...analysisLocation },
    signal,
  )) as LocalResponse
  if (!value.source || !Array.isArray(value.source.skills))
    throw new Error("技能库返回的数据格式不正确。")
  let analysis: Dataset | null = null
  let analysisError = value.analysisError
  try {
    if (value.graph) analysis = parseSnapshot(value.graph, `${value.name} / 分析结果`)
  } catch (error) {
    analysisError = error instanceof Error ? error.message : "分析快照格式不正确。"
  }
  return {
    connection: (value as any).connection ? { ...(value as any).connection, id: `local:${(value as any).connection.id}` } : undefined,
    source: value.source,
    analysis,
    analysisRevision: value.analysisRevision || null,
    analysisMode: analysis ? (value.graph as { embedding_model?: string }).embedding_model === '' ? 'model' : 'vector' : null,
    analysisError,
    analysisStatus: analysisError ? 'error' : analysis ? 'ready' : 'missing',
    warnings: value.warnings,
    changedSkills: value.changedSkills,
    removedSkills: value.removedSkills,
    addedSkills: value.addedSkills,
  }
}
