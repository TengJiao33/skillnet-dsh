export async function api(action: string, args: object = {}, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`api/skillnet/${action}`, action === 'status' ? { signal } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(response.status === 404 ? '插件后端仍是旧版。请在当前任务结束后重启 DSH，再打开 SkillNet。' : '无法连接 SkillNet 后端。')
  const value = await response.json()
  if (!response.ok || !value.ok) throw new Error(value.error?.message || 'SkillNet 请求失败。')
  return value.data
}
