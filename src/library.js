import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const validName = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export async function projectRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('请选择项目的绝对目录路径。');
  let current = await realpath(path);
  if (!(await lstat(current)).isDirectory()) throw new Error('项目路径必须是文件夹。');
  const fallback = current;
  while (true) {
    if (await exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

// Create only known child directories; reject junctions/symlinks at publish boundaries.
async function directory(base, ...parts) {
  await mkdir(base, { recursive: true });
  let current = await realpath(base);
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current, { recursive: true });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`技能目录不能是链接或普通文件：${current}`);
  }
  return current;
}

export function createLibrary(run, skills, config = {}) {
  const selected = config.dshHome || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const home = resolve(selected === '~' ? homedir() : /^~[/\\]/.test(selected) ? join(homedir(), selected.slice(2)) : selected);
  const data = join(home, 'skillnet');
  let queue = Promise.resolve();
  const mutate = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function save(kind, id, value) {
    const root = await directory(home, 'skillnet', kind);
    const temporary = join(root, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, join(root, `${id}.json`));
  }
  async function load(kind, id) {
    if (!validId(id)) throw new Error('技能记录无效，请重新打开详情。');
    try { return JSON.parse(await readFile(join(data, kind, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('技能记录不存在，请重新预览。'); throw error; }
  }
  async function recordPath(record) {
    if (!validName(record.name)) throw new Error('无效的技能名称。');
    const base = record.scope === 'user' ? home : await projectRoot(record.projectRoot);
    const root = record.scope === 'user' ? await directory(base, 'skills') : await directory(base, '.dsh', 'skills');
    const path = join(root, record.name);
    if (!samePath(path, record.path)) throw new Error('安装记录与实际目录不一致，已停止操作。');
    const info = await exists(path);
    if (info?.isSymbolicLink()) throw new Error('技能目录已被替换为链接，已停止操作。');
    return path;
  }
  async function removedPath(record) {
    const base = record.scope === 'user' ? home : await projectRoot(record.projectRoot);
    const root = record.scope === 'user'
      ? await directory(base, 'skillnet', 'removed', record.id)
      : await directory(base, '.dsh', 'skillnet-removed', record.id);
    return join(root, record.name);
  }
  async function reconcile(record) {
    const path = await recordPath(record);
    const backup = await removedPath(record);
    const original = await exists(path);
    const removed = await exists(backup);
    if (removed?.isSymbolicLink()) throw new Error('技能备份目录已被替换为链接。');
    let state = record.state;
    // The backup path belongs exclusively to this installation. Resolve both
    // journalled operations and interruptions left by versions before 0.4.
    if (!original && removed && state === 'installed') state = 'removed';
    if (original && !removed && state === 'removed') state = 'installed';
    if (original && removed && record.operation) return { ...record, recoveryWarning: '原目录和备份同时存在，请检查冲突；两个副本均已保留。' };
    if (state !== record.state || record.operation) {
      const { operation, ...settled } = record;
      record = { ...settled, state, recoveredAt: new Date().toISOString() };
      await save('installations', record.id, record);
    }
    return record;
  }
  const installation = id => mutate(async () => reconcile(await load('installations', id)));
  async function native(name, cwd, signal, expected, scope) {
    const found = await skills.get(name, { cwd: cwd || undefined, signal, scope });
    return {
      available: Boolean(found),
      effective: Boolean(found && (!expected || found.path && samePath(found.path, join(expected, 'SKILL.md')))),
      path: found?.path || null,
      source: found?.source || null,
      modelInvocable: found?.invocation?.modelInvocable ?? false,
      userInvocable: found?.invocation?.userInvocable ?? false,
    };
  }
  async function verify(record, signal, wait = false, cwd, scope) {
    const lookupCwd = cwd || record.projectRoot;
    let value;
    for (let attempt = 0; attempt < (wait ? 12 : 1); attempt++) {
      signal?.throwIfAborted();
      value = await native(record.name, lookupCwd, signal, record.path, scope);
      if (value.effective) break;
      if (wait) await setTimeout(150, undefined, { signal });
    }
    return value;
  }
  async function prepare(args, signal) {
    const id = randomUUID();
    const root = await directory(home, 'skillnet', 'staging', id);
    try {
      const detail = await run({ action: 'inspect', url: args.url, target_dir: root }, signal);
      if (!validName(detail.name) || !detail.validation.valid) throw new Error('技能未通过官方结构校验。');
      const catalog = args.catalog?.skill_url === args.url ? Object.fromEntries(['repo_name', 'stars', 'category', 'evaluation'].filter(key => args.catalog[key] !== undefined).map(key => [key, args.catalog[key]])) : null;
      const record = { id, url: args.url, name: detail.name, catalog, preparedAt: new Date().toISOString() };
      await save('previews', id, record);
      return { ...detail, catalog, previewId: id };
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  async function install(args, signal) {
    return mutate(async () => {
      const preview = await load('previews', args.previewId);
      if (!validName(preview.name)) throw new Error('技能名称无效。');
      if (!['user', 'project'].includes(args.scope)) throw new Error('请选择个人或项目安装范围。');
      const project = args.scope === 'project' ? await projectRoot(args.projectPath) : null;
      const parent = args.scope === 'user' ? await directory(home, 'skills') : await directory(project, '.dsh', 'skills');
      const destination = join(parent, preview.name);
      if (await exists(destination) || await exists(join(parent, `${preview.name}.md`))) throw new Error(`同名技能已存在，未覆盖：${destination}`);
      const source = join(data, 'staging', preview.id, preview.name);
      const detail = await run({ action: 'check', path: source }, signal);
      if (!detail.validation.valid) throw new Error(detail.validation.errors.join('\n'));
      signal?.throwIfAborted();
      const record = { id: randomUUID(), name: detail.name, description: detail.metadata.description, catalog: preview.catalog, url: preview.url, path: destination, projectRoot: project, scope: args.scope, installedAt: new Date().toISOString(), state: 'installed' };
      const pending = join(parent, `.skillnet-pending-${record.id}`);
      try {
        await cp(source, pending, { recursive: true, errorOnExist: true, force: false });
        signal?.throwIfAborted();
        if (await exists(destination)) throw new Error('安装期间出现同名目录，已保留现有文件。');
        await rename(pending, destination);
        try { await save('installations', record.id, record); }
        catch (error) { await rename(destination, pending); throw error; }
      } finally { await rm(pending, { recursive: true, force: true }); }
      // Publication has completed; cancellation must not hide the committed result.
      return { ...record, native: await verify(record, undefined, true) };
    });
  }
  async function records() {
    let entries;
    try { entries = await readdir(join(data, 'installations')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [], warnings = [];
    for (const name of entries.filter(name => name.endsWith('.json'))) {
      try { records.push(await reconcile(await load('installations', name.slice(0, -5)))); }
      catch { warnings.push(`安装记录无法读取：${name}`); }
    }
    return { records, warnings };
  }
  async function list(args = {}, signal, scope) {
    const result = await mutate(records);
    const all = Array.isArray(result) ? result : result.records;
    const installed = await Promise.all(all.map(async record => ({ ...record, exists: Boolean(await exists(record.path)), native: record.state === 'installed' ? await verify(record, signal, false, args.cwd, scope) : null })));
    const snapshot = await skills.snapshot({ cwd: args.cwd || undefined, signal, scope });
    return { installed: installed.sort((a, b) => b.installedAt.localeCompare(a.installedAt)), catalog: snapshot.skills, complete: snapshot.complete, home, warnings: result.warnings || [] };
  }
  async function inspectInstalled(args, signal) {
    const record = await installation(args.id);
    if (record.state !== 'installed') throw new Error('技能已移除，可在“已移除”列表恢复。');
    const path = await recordPath(record);
    return { ...await run({ action: 'check', path }, signal), catalog: record.catalog, url: record.url, installationId: record.id, native: await verify(record, signal), record };
  }
  async function file(args, signal) {
    const record = args.previewId ? await load('previews', args.previewId) : await installation(args.id);
    if (!args.previewId && record.state !== 'installed') throw new Error('技能已移除，请先恢复。');
    const path = args.previewId ? join(data, 'staging', record.id, record.name) : await recordPath(record);
    return run({ action: 'file', path, file: args.file }, signal);
  }
  async function remove(args) {
    return mutate(async () => {
      const record = await reconcile(await load('installations', args.id));
      if (record.state !== 'installed') throw new Error('技能已移除。');
      const path = await recordPath(record);
      const target = await removedPath(record);
      if (await exists(target)) throw new Error('备份目录已有内容，已保留两个副本，请先检查冲突。');
      await save('installations', record.id, { ...record, operation: 'remove' });
      await rename(path, target);
      const removed = { ...record, state: 'removed', removedAt: new Date().toISOString() };
      try { await save('installations', record.id, removed); }
      catch (error) { await rename(target, path); throw error; }
      return removed;
    });
  }
  async function restore(args, signal) {
    return mutate(async () => {
      const record = await reconcile(await load('installations', args.id));
      if (record.state !== 'removed') throw new Error('技能尚未移除。');
      const path = await recordPath(record);
      if (await exists(path) || await exists(join(dirname(path), `${record.name}.md`))) throw new Error('同名技能已存在，恢复不会覆盖现有文件。');
      const source = await removedPath(record);
      await save('installations', record.id, { ...record, operation: 'restore' });
      await rename(source, path);
      const restored = { ...record, state: 'installed' };
      try { await save('installations', record.id, restored); }
      catch (error) { await rename(path, source); throw error; }
      return { ...restored, native: await verify(restored, signal, true) };
    });
  }
  async function prepareLocal(path, signal) {
    const detail = await run({ action: 'check', path }, signal);
    if (!validName(detail.name) || !detail.validation.valid) throw new Error('草稿未通过官方结构校验。');
    const id = randomUUID();
    const root = await directory(home, 'skillnet', 'staging', id);
    await cp(path, join(root, detail.name), { recursive: true, dereference: false });
    await save('previews', id, { id, url: null, name: detail.name, catalog: null, preparedAt: new Date().toISOString() });
    return { ...detail, previewId: id };
  }
  return { home, prepare, prepareLocal, install, list, inspectInstalled, file, remove, restore, verify: async (args, signal) => verify(await installation(args.id), signal, true, args.cwd) };
}
