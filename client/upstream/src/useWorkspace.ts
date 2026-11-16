import { useEffect, useRef, useState } from 'react'
import { parseSnapshot } from './data'
import type { Dataset } from './data'
import { unifiedLibrary, createDefaultLibrary, initialLibraryPath, readLocalLibrary } from './localLibrary'
import type { LocalLibrary, LocalLibraryData } from './localLibrary'
import {
  clearImport,
  loadImports,
  loadLocalLibraries,
  loadView,
  removeLocalLibrary,
  saveImport,
  saveView,
} from './persistence'
import { firstConnectedSkill } from './selection'

const empty: Dataset = { kind: 'source', title: "我的技能库", skills: [], relations: [] }
type Imported = { id: string; dataset: Dataset }
type WorkspaceState = {
  dataset: Dataset
  localData: LocalLibraryData | null
  localLibraries: LocalLibrary[]
  importedDatasets: Imported[]
  collection: string
  sourceId: string
  selectedSkillId: string
}
let rememberedWorkspace: WorkspaceState | null = null
let preparingWorkspace: Promise<WorkspaceState> | null = null
const pendingReads = new Map<string, Promise<LocalLibraryData>>()

function comparablePath(value: string) {
  const path = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:|^\/\//.test(path) ? path.toLowerCase() : path
}

// Navigation does not own these reads: leaving the panel must not cancel a
// useful preload or restart Python. Only completed view state is remembered.
function refreshLibrary(library: LocalLibrary): Promise<LocalLibraryData> {
  const key = comparablePath(library.sourcePath)
  const pending = pendingReads.get(key)
  if (pending) return pending
  const read = readLocalLibrary(library, AbortSignal.timeout(30_000)).finally(() => pendingReads.delete(key))
  pendingReads.set(key, read)
  return read
}

export function preloadWorkspace(): Promise<WorkspaceState> {
  if (rememberedWorkspace) return Promise.resolve(rememberedWorkspace)
  if (preparingWorkspace) return preparingWorkspace
  preparingWorkspace = (async () => {
    const [savedImports, libraries, initialPath] = await Promise.all([
      loadImports().catch(() => []),
      loadLocalLibraries().catch((): LocalLibrary[] => []),
      initialLibraryPath(),
    ])
    const imported = savedImports.flatMap((item) => {
      try { return [{ id: item.id, dataset: parseSnapshot(JSON.parse(item.json), item.name) }] }
      catch { return [] }
    })
    const view = loadView()
    let local = initialPath
      ? libraries.find(item => comparablePath(item.sourcePath) === comparablePath(initialPath))
      : libraries.find(item => item.id === view?.collection)
    if (initialPath && !local) {
      local = { id: `local:initial:${encodeURIComponent(initialPath)}`, name: initialPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || initialPath, sourcePath: initialPath }
      libraries.push(local)
    }
    let state: WorkspaceState = { dataset: empty, localData: null, localLibraries: libraries, importedDatasets: imported, collection: 'personal', sourceId: 'personal', selectedSkillId: '' }
    if (local) {
      const data = await refreshLibrary(local)
      const canonical = data.connection || local
      const dataset = unifiedLibrary(data)
      state = { ...state, dataset, localData: data, localLibraries: libraries.map(item => item === local ? canonical : item), collection: canonical.id, sourceId: 'local-library', selectedSkillId: dataset.skills.some(skill => skill.id === view?.selectedSkillId) ? view!.selectedSkillId : firstConnectedSkill(data.analysis || dataset) }
    } else if (view?.sourceId === 'imported') {
      const item = imported.find(item => item.id === view.collection)
      if (item) state = { ...state, dataset: item.dataset, collection: item.id, sourceId: 'imported', selectedSkillId: item.dataset.skills.some(skill => skill.id === view.selectedSkillId) ? view.selectedSkillId : firstConnectedSkill(item.dataset) }
    }
    rememberedWorkspace = state
    return state
  })().catch(error => { preparingWorkspace = null; throw error })
  return preparingWorkspace
}

export function useWorkspace() {
  const [initial] = useState(() => rememberedWorkspace)
  const [dataset, setDataset] = useState<Dataset>(initial?.dataset || empty)
  const [localData, setLocalData] = useState<LocalLibraryData | null>(initial?.localData || null)
  const [localLibraries, setLocalLibraries] = useState<LocalLibrary[]>(initial?.localLibraries || [])
  const [importedDatasets, setImportedDatasets] = useState<Imported[]>(initial?.importedDatasets || [])
  const [collection, setCollection] = useState(initial?.collection || 'personal')
  const [sourceId, setSourceId] = useState(initial?.sourceId || 'personal')
  const [selectedSkillId, setSelectedSkillId] = useState(initial?.selectedSkillId || '')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(!initial)
  const operation = useRef<AbortController | null>(null)
  const background = useRef<AbortController | null>(null)
  const currentView = useRef({ collection, sourceId, selectedSkillId, analysisRevision: localData?.analysisRevision })
  currentView.current = { collection, sourceId, selectedSkillId, analysisRevision: localData?.analysisRevision }

  const select = (
    data: Dataset,
    library: string,
    source: string,
    local: LocalLibraryData | null = null,
    selected = '',
  ) => {
    setDataset(data)
    setCollection(library)
    setSourceId(source)
    setLocalData(local)
    setSelectedSkillId(
      data.skills.some((skill) => skill.id === selected) ? selected : firstConnectedSkill(data),
    )
  }
  const selectLocal = (
    library: LocalLibrary,
    data: LocalLibraryData,
    selected = '',
  ) => {
    select(
      unifiedLibrary(data),
      library.id,
      'local-library',
      data,
      selected,
    )
  }

  // Every asynchronous user action passes through one gate. Controls cannot launch
  // overlapping reads/writes, and unmounted or superseded requests cannot publish state.
  const run = async (work: (signal: AbortSignal) => Promise<() => void>) => {
    if (operation.current || restoring) return
    background.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setLoading(true)
    setError(null)
    try {
      const commit = await work(controller.signal)
      if (!controller.signal.aborted) commit()
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "无法加载技能库。")
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    background.current = controller
    const restore = async () => {
      try {
        if (initial) {
          const library = initial.localLibraries.find(item => item.id === initial.collection)
          if (!library) return
          const result = await refreshLibrary(library)
          if (controller.signal.aborted) return
          const view = currentView.current
          if (view.collection !== initial.collection) return
          const canonical = result.connection || library
          setLocalLibraries(previous => previous.map(item => item.id === library.id ? canonical : item))
          selectLocal(canonical, result, view.selectedSkillId)
        } else {
          const state = await preloadWorkspace()
          if (controller.signal.aborted) return
          setImportedDatasets(state.importedDatasets)
          setLocalLibraries(state.localLibraries)
          select(state.dataset, state.collection, state.sourceId, state.localData, state.selectedSkillId)
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "无法恢复上次打开的技能库。")
      } finally {
        if (!controller.signal.aborted) {
          setRestoring(false)
        }
      }
    }
    void restore()
    return () => {
      controller.abort()
      operation.current?.abort()
      operation.current = null
      background.current = null
    }
    // Restoration runs once; later changes are explicit user operations.
  }, [])

  useEffect(() => {
    if (!restoring) {
      rememberedWorkspace = { dataset, localData, localLibraries, importedDatasets, collection, sourceId, selectedSkillId }
      saveView({ collection, sourceId, selectedSkillId, analysisRevision: localData?.analysisRevision })
    }
  }, [restoring, dataset, localData, localLibraries, importedDatasets, collection, sourceId, selectedSkillId])

  const showPersonalLibrary = () => select(empty, 'personal', 'personal')
  const openLocalLibrary = (library: LocalLibrary) =>
    run(async (signal) => {
      const result = await readLocalLibrary(library, signal)
      const canonical = result.connection || library
      return () => {
        setLocalLibraries(previous => previous.map(item => item.id === library.id ? canonical : item))
        selectLocal(canonical, result, library.id === collection ? selectedSkillId : '')
      }
    })
  const connect = async (sourcePath: string, signal: AbortSignal) => {
    if (!sourcePath.trim()) throw new Error("请输入技能目录路径。")
    const existing = localLibraries.find(
      (item) => comparablePath(item.sourcePath) === comparablePath(sourcePath),
    )
    let library = existing ?? {
      id: `local:${crypto.randomUUID()}`,
      name:
        sourcePath
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || sourcePath,
      sourcePath,
    }
    const result = await readLocalLibrary(library, signal)
    library = result.connection || library
    return () => {
      setLocalLibraries((previous) => [...previous.filter(item => item.id !== existing?.id && item.id !== library.id), library])
      selectLocal(library, result)
    }
  }
  const connectLocalLibrary = (path: string) => run((signal) => connect(path.trim(), signal))
  useEffect(() => {
    const refresh = (event: Event) => {
      const connection = (event as CustomEvent).detail
      if (connection?.sourcePath) void connectLocalLibrary(connection.sourcePath)
    }
    window.addEventListener('skillnet-library-changed', refresh)
    return () => window.removeEventListener('skillnet-library-changed', refresh)
  })
  const createPersonalLibrary = () =>
    run(async (signal) => connect(await createDefaultLibrary(), signal))
  const updateIndex = (indexPath?: string) =>
    run(async (signal) => {
      const library = localLibraries.find((item) => item.id === collection)
      if (!library) throw new Error("请先选择本地技能库。")
      const updated = { ...library, indexPath }
      const result = await readLocalLibrary(updated, signal, { indexPath: indexPath || null })
      if (indexPath && !result.analysis)
        throw new Error(result.analysisError || "这个目录中没有可用的分析结果。")
      const canonical = result.connection || updated
      return () => {
        setLocalLibraries((previous) =>
          previous.map((item) => (item.id === updated.id ? canonical : item)),
        )
        selectLocal(canonical, result, selectedSkillId)
      }
    })
  const forgetLocalLibrary = () =>
    run(async () => {
      let warning: string | null = null
      await removeLocalLibrary(collection).catch(() => {
        warning = "已断开当前连接，但未能保存更改，重新打开后可能仍会显示。"
      })
      return () => {
        setLocalLibraries((previous) => previous.filter((item) => item.id !== collection))
        showPersonalLibrary()
        setError(warning)
      }
    })
  const importFile = (file?: File) => {
    if (!file) return Promise.resolve()
    return run(async () => {
      if (file.size > 20 * 1024 * 1024) throw new Error("文件大小不能超过 20 MB。")
      const json = await file.text()
      let value: unknown
      try { value = JSON.parse(json) } catch { throw new Error('无法解析图谱文件，请选择有效的 JSON 文件。') }
      const parsed = parseSnapshot(value, file.name)
      const id = `imported:${crypto.randomUUID()}`
      let warning: string | null = null
      await saveImport({ id, name: file.name, json }).catch(() => {
        warning = "快照已打开，但未能保存到浏览记录。"
      })
      return () => {
        setImportedDatasets((previous) => [...previous, { id, dataset: parsed }])
        select(parsed, id, 'imported')
        setError(warning)
      }
    })
  }
  const removeImport = () =>
    run(async () => {
      let warning: string | null = null
      await clearImport(collection).catch(() => {
        warning = "已移除当前快照，但未能保存更改，重新打开后可能仍会显示。"
      })
      return () => {
        setImportedDatasets((previous) => previous.filter((item) => item.id !== collection))
        showPersonalLibrary()
        setError(warning)
      }
    })
  const changeLibrary = (name: string) => {
    if (operation.current || restoring) return
    background.current?.abort()
    setError(null)
    if (name === 'personal') {
      showPersonalLibrary()
      return
    }
    const local = localLibraries.find((item) => item.id === name)
    const imported = importedDatasets.find((item) => item.id === name)
    if (local) void openLocalLibrary(local)
    else if (imported) select(imported.dataset, name, 'imported')
  }

  return {
    dataset,
    localData,
    localLibraries,
    importedDatasets,
    collection,
    sourceId,
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
  }
}
