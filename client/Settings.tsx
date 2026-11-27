import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { api } from './api'
import { invalidateInitialCatalog } from './pages'
import { Select } from './Select'

type SettingField = readonly [key: string, label: string, secret?: true]
const groups: readonly (readonly [string, string, readonly SettingField[]])[] = [
  ['独立模型 API', '高级', [['base_url', 'OpenAI 兼容接口地址'], ['model', '模型'], ['api_key', 'API 密钥', true]]],
  ['向量模型', '可选', [['embedding_base_url', '接口地址'], ['embedding_model', '模型'], ['embedding_api_key', 'API 密钥', true]]],
  ['独立路由 API', '高级', [['explorer_base_url', 'DeepSeek Messages 接口地址'], ['explorer_model', '模型'], ['explorer_api_key', 'API 密钥', true]]],
  ['GitHub 与目录服务', '可选', [['github_token', 'GitHub Token', true], ['github_mirror', 'GitHub 下载镜像'], ['skillnet_api_url', 'SkillNet 目录服务地址']]],
]
const dependencies: Record<string, string> = { graph: '图谱组件', claude: 'Claude 探索器', codex: 'Codex 探索器', dsh: 'DSH 探索器' }
type Fields = Record<string, { value: string | boolean | null, source: string }>
type SettingsData = { fields: Fields, checks: { dependencies: Record<string, boolean> } }

export function Settings({ active }: { active: boolean }) {
  const id = useId()
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [clearSecrets, setClearSecrets] = useState<string[]>([])
  const [message, setMessage] = useState<{ error: boolean, text: string } | null>(null)
  const [readRevision, setReadRevision] = useState(0)
  const [reading, setReading] = useState(true)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const saveButton = useRef<HTMLButtonElement>(null)
  const dirty = Object.keys(values).length > 0 || clearSecrets.length > 0
  useEffect(() => {
    if (!active || dirty || saving.current) return
    const controller = new AbortController()
    setReading(true)
    setMessage(null)
    void api('settings', {}, controller.signal).then(data => {
      if (!controller.signal.aborted) setSettings(data)
    }).catch(error => {
      if (!controller.signal.aborted) setMessage({ error: true, text: error.message })
    }).finally(() => {
      if (!controller.signal.aborted) setReading(false)
    })
    return () => controller.abort()
    // Reload clean forms on entry. An edit or save must not trigger a read.
  }, [active, readRevision])

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving.current || reading || !settings) return
    saving.current = true
    setBusy(true)
    setMessage(null)
    try {
      const submitted = Object.fromEntries(Object.entries(values).filter(([key]) => !clearSecrets.includes(key)))
      const updated: SettingsData = await api('settings', { values: submitted, clearSecrets })
      if (updated.fields.skillnet_api_url?.value !== settings.fields.skillnet_api_url?.value) invalidateInitialCatalog()
      setSettings(updated)
      setValues({})
      setClearSecrets([])
      setMessage({ error: false, text: '已保存。' })
    } catch (error: any) { setMessage({ error: true, text: error.message }) }
    finally { saving.current = false; setBusy(false) }
  }

  const disabled = busy || reading || !settings
  const setValue = (key: string, value: string) => {
    setValues(previous => ({ ...previous, [key]: value }))
    setMessage(null)
  }
  return <main className="dsh-page dsh-settings-page" hidden={!active}>
    <header><h1>设置</h1><p>默认使用 DSH 当前模型。需要独立接口、向量检索或自定义下载服务时，可在这里配置。</p></header>
    {settings && <div className="dsh-checks" aria-label="依赖状态">{Object.entries(settings.checks.dependencies).map(([name, found]) =>
      <span key={name} data-ready={found}>{dependencies[name] || name} {found ? '已就绪' : '未安装'}</span>)}</div>}
    <form onSubmit={save}>
      <div className="dsh-settings-grid">{groups.map(([label, kind, items]) => <section className="dsh-card" key={label}>
        <header><h2>{label}</h2><span>{kind}</span></header>
        {items.map(([key, name, secret]) => {
          const fieldId = id + '-' + key
          const field = settings?.fields[key]
          const defaultCatalog = key === 'skillnet_api_url' && field?.source === 'default'
          const configured = secret && field?.value === true
          const clearing = clearSecrets.includes(key)
          const placeholder = configured ? '已配置，留空保留' : key === 'skillnet_api_url' ? '留空使用默认目录服务' : undefined
          return <div className="dsh-settings-field" key={key}>
            <label htmlFor={fieldId}>{name}</label>
            <input id={fieldId} type={secret ? 'password' : 'text'} autoComplete={secret ? 'new-password' : 'off'}
              disabled={disabled || clearing} value={values[key] ?? (secret || defaultCatalog ? '' : String(field?.value ?? ''))}
              placeholder={placeholder} onChange={event => setValue(key, event.target.value)} />
            {key === 'github_mirror' && <small>用于匿名下载失败后的回退。</small>}
            {configured && <label className="dsh-clear"><input type="checkbox" disabled={disabled} checked={clearing}
              onChange={event => { setMessage(null); setClearSecrets(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key)) }} />清除已保存的密钥</label>}
          </div>
        })}
      </section>)}</div>
      <footer className="dsh-settings-footer">
        <label>结构化输出 <Select aria-label="结构化输出" disabled={disabled} value={values.json_mode ?? String(settings?.fields.json_mode?.value ?? 'auto')} onValueChange={value => setValue('json_mode', value)}>
          <option value="auto">自动</option><option value="on">严格 JSON Schema</option><option value="off">关闭协议参数</option>
        </Select></label>
        <div className="dsh-settings-status">
          {message?.error ? <span role="alert"><AlertCircle size={15} aria-hidden="true" />{message.text}</span>
            : <span role="status">{busy ? <><Loader2 size={15} className="dsh-progress-icon" aria-hidden="true" />正在保存…</>
              : message ? <><Check size={15} aria-hidden="true" />{message.text}</>
                : reading ? '正在读取设置…' : dirty ? '有未保存的修改' : ''}</span>}
        </div>
        {!dirty && message?.error && <button type="button" onClick={() => setReadRevision(value => value + 1)}>重新读取</button>}
        {dirty && <button type="button" disabled={disabled} onClick={() => {
          setValues({}); setClearSecrets([]); setMessage({ error: false, text: '已放弃修改。' }); saveButton.current?.focus()
        }}>放弃修改</button>}
        <button ref={saveButton} type="submit" className="primary-button" disabled={disabled}>保存设置</button>
      </footer>
    </form>
  </main>
}
