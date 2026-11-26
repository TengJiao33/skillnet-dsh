import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const validTaskId = id => typeof id === 'string' && /^skillnet-(analyze|route|create|evaluate|evaluate-batch)-[0-9a-f]+$/.test(id);

export function createTaskStore(root) {
  const summaries = new Map();
  let loading;
  let damaged = 0;
  let sorted;
  async function atomic(folder, id, value) {
    const directory = join(root, folder);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(directory, `${id}.json`));
  }
  async function write(record) {
    if (!validTaskId(record.id)) throw new Error('任务编号无效。');
    const { result, ...summary } = record;
    if (result !== undefined) {
      await atomic('results', record.id, result);
      if (record.action === 'evaluate-batch') summary.resultAvailable = true;
    }
    await atomic('tasks', record.id, summary);
    summaries.set(record.id, summary);
    sorted = undefined;
  }
  async function load() {
    if (!loading) loading = (async () => {
      let files;
      try { files = await readdir(join(root, 'tasks')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const file of files.filter(name => name.endsWith('.json'))) {
        try {
          const record = JSON.parse(await readFile(join(root, 'tasks', file), 'utf8'));
          if (!validTaskId(record.id) || file !== `${record.id}.json` || typeof record.startedAt !== 'string') throw new Error('Invalid task metadata');
          // Migrate old records once. Subsequent lists never open large results.
          if (Object.hasOwn(record, 'result')) await write(record);
          else if (!summaries.has(record.id)) summaries.set(record.id, record);
        } catch { damaged++; }
      }
      sorted = undefined;
    })().catch(error => { loading = undefined; throw error; });
    await loading;
  }
  async function get(id, owner, withResult = true) {
    if (!validTaskId(id)) throw new Error('任务编号无效。');
    await load();
    const record = summaries.get(id);
    if (!record || owner && record.owner && record.owner !== owner) throw new Error('任务不存在或不属于当前会话。');
    const value = { ...record };
    if (withResult && (record.status === 'completed' || record.action === 'evaluate-batch' && record.resultAvailable)) {
      try { value.result = JSON.parse(await readFile(join(root, 'results', id + '.json'), 'utf8')); }
      catch (error) { value.resultError = '结果文件无法读取，其他作业不受影响。'; }
    }
    return value;
  }
  async function ordered() {
    await load();
    return sorted ||= [...summaries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async function list(args = {}, owner) {
    const filtered = (await ordered()).filter(task => (!owner || !task.owner || task.owner === owner) && (!args.sourcePath || task.sourcePath === args.sourcePath) && (!args.action || task.action === args.action) && (!args.skillId || task.skillId === args.skillId) && (!args.status || task.status === args.status));
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
    return { items: filtered.slice(offset, offset + limit).map(task => ({ ...task })), total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length, damaged };
  }
  async function evaluationsBySkill(sourcePath) {
    const bySkill = new Map();
    for (const task of await ordered()) {
      if (task.action !== 'evaluate' || task.status !== 'completed' || task.sourcePath !== sourcePath) continue;
      if (!bySkill.has(task.skillId)) bySkill.set(task.skillId, []);
      bySkill.get(task.skillId).push(task);
    }
    return bySkill;
  }
  return { write, get, list, evaluationsBySkill };
}
