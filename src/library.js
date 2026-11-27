import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const validName = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const validOrigin = origin => validId(origin?.libraryId) && typeof origin.skillId === 'string' && origin.skillId.length > 0;
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

async function packageSnapshot(expectedPath, signal, includeSource = false) {
  signal?.throwIfAborted();
  if (typeof expectedPath !== 'string' || !isAbsolute(expectedPath) || !samePath(expectedPath, join(dirname(expectedPath), 'SKILL.md'))) {
    throw new Error('技能包指令路径无效。');
  }
  const root = dirname(expectedPath);
  if (!samePath(await realpath(root), root) || !(await lstat(expectedPath)).isFile()) {
    throw new Error('技能包路径已改变或包含链接。');
  }
  const manifest = createHash('sha256').update('skillnet-package-v1\n');
  const files = new Map();
  let source;
  async function visit(path, relative) {
    signal?.throwIfAborted();
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      manifest.update(JSON.stringify(['directory', relative]) + '\n');
      if (relative) files.set(relative + '/', 'directory');
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relative ? relative + '/' + name : name);
      }
      return;
    }
    if (!info.isFile()) throw new Error('技能包含有链接或非普通文件。');
    const hash = createHash('sha256');
    if (includeSource && samePath(path, expectedPath)) {
      const buffer = await readFile(path, { signal });
      hash.update(buffer);
      source = buffer.toString('utf8');
    } else {
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    }
    const digest = hash.digest('hex');
    manifest.update(JSON.stringify(['file', relative, digest]) + '\n');
    files.set(relative, digest);
  }
  await visit(root, '');
  signal?.throwIfAborted();
  return { version: manifest.digest('hex'), files, source };
}

const sourcePackageVersion = async (path, signal) => (await packageSnapshot(path, signal)).version;

async function matchesPackage(path, version, signal) {
  try { return await sourcePackageVersion(path, signal) === version; }
  catch { signal?.throwIfAborted(); return false; }
}

function packageChanges(current, remote) {
  const paths = [...new Set([...current.files.keys(), ...remote.files.keys()])].sort();
  return paths.filter(path => current.files.get(path) !== remote.files.get(path)).map(path => ({
    path,
    kind: !current.files.has(path) ? 'added' : !remote.files.has(path) ? 'removed' : 'modified',
  }));
}

function hasRemoteSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/[^/]+\/[^/]+\/(?:tree|blob)\/[^/]+(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

function libraryFolderName(name) {
  const safe = name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[ .]+$/, '') || '技能库';
  const reserved = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i;
  return reserved.test(safe.split('.', 1)[0].trimEnd()) ? '_' + safe : safe;
}

export async function managedLibraryInfo(home, path) {
  const folder = dirname(path);
  if (!samePath(path, join(folder, 'skills'))) return null;
  const base = await realpath(home).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!base || !samePath(dirname(folder), join(base, 'skillnet', 'libraries'))) return null;
  const manifest = join(folder, 'library.json');
  const info = await exists(manifest);
  if (info) {
    if (!info.isFile()) throw new Error('独立技能库记录无效。');
    const { id, name } = JSON.parse(await readFile(manifest, 'utf8'));
    if (!validId(id) || typeof name !== 'string' || !name.trim()) throw new Error('独立技能库记录无效。');
    return { id, name };
  }
  // Libraries created before named folders store the ID in the directory name.
  const id = basename(folder);
  const previousName = join(folder, 'name.txt');
  if (!validId(id) || !(await exists(previousName))?.isFile()) return null;
  return { id, name: await readFile(previousName, 'utf8') };
}

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
  async function createManaged(name) {
    const id = randomUUID();
    const root = await directory(home, 'skillnet', 'libraries');
    const base = libraryFolderName(name);
    let folder = join(root, base);
    for (let suffix = 2; ; suffix++) {
      try { await mkdir(folder); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        folder = join(root, base + '-' + suffix);
      }
    }
    const path = join(folder, 'skills');
    try {
      await mkdir(path);
      await writeFile(join(folder, 'library.json'), JSON.stringify({ id, name }, null, 2), { flag: 'wx' });
      return path;
    } catch (error) {
      await rmdir(path).catch(() => {});
      await rmdir(folder).catch(() => {});
      throw error;
    }
  }
  async function managedPath(id, path) {
    if (!validId(id) || typeof path !== 'string' || !isAbsolute(path)) throw new Error('独立技能库标识无效。');
    if (!samePath(await realpath(path), path) || !(await lstat(path)).isDirectory() ||
      (await managedLibraryInfo(home, path))?.id !== id) {
      throw new Error('独立技能库的目录已改变，请重新连接。');
    }
    return path;
  }
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
  async function installationFiles() {
    try { return (await readdir(join(data, 'installations'))).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function trackedInstallations(path, signal) {
    const matches = [];
    for (const file of await installationFiles()) {
      signal?.throwIfAborted();
      const id = file.slice(0, -5);
      const record = await load('installations', id).catch(() => null);
      if (record?.id === id && record.state === 'installed' &&
        typeof record.path === 'string' && isAbsolute(record.path) && samePath(record.path, path)) {
        matches.push(record);
      }
    }
    return matches;
  }
  async function personalOrigins(path, name, origin, signal) {
    return (await trackedInstallations(path, signal)).filter(record =>
      record.scope === 'user' && !record.operation && record.name === name &&
      record.origin?.libraryId === origin.libraryId && record.origin?.skillId === origin.skillId);
  }
  async function recordPath(record) {
    if (!validName(record.name)) throw new Error('无效的技能名称。');
    const root = await installRoot(record.scope === 'project'
      ? { ...record, projectRoot: await projectRoot(record.projectRoot) }
      : record);
    const path = join(root, record.name);
    if (!samePath(path, record.path)) throw new Error('安装记录与实际目录不一致，已停止操作。');
    const info = await exists(path);
    if (info?.isSymbolicLink()) throw new Error('技能目录已被替换为链接，已停止操作。');
    return path;
  }
  async function removedPath(record) {
    const root = record.scope === 'project'
      ? await directory(await projectRoot(record.projectRoot), '.dsh', 'skillnet-removed', record.id)
      : await directory(home, 'skillnet', 'removed', record.id);
    return join(root, record.name);
  }
  async function updatePaths(record, previewId) {
    if (!validId(record.id) || !validId(previewId)) throw new Error('更新预览标识无效。');
    const root = record.scope === 'project'
      ? await directory(await projectRoot(record.projectRoot), '.dsh', 'skillnet-versions', record.id, previewId)
      : await directory(home, 'skillnet', 'versions', record.id, previewId);
    return { backup: join(root, record.name), incoming: join(root, '.incoming') };
  }
  function updatedRecord(record, update, backup) {
    return { ...record, description: update.description, packageVersion: update.remoteVersion,
      updatedAt: update.updatedAt, backupPath: backup };
  }
  async function reconcileUpdate(record, path) {
    const { operation, pendingUpdate: update, ...previous } = record;
    const warning = '技能更新尚未恢复。已保留现有文件与旧版本备份，请先检查路径冲突。';
    if (!validId(update?.previewId)) return { ...record, recoveryWarning: warning };
    const { backup, incoming } = await updatePaths(record, update.previewId);
    const current = await exists(path);
    const saved = await exists(backup);
    const blocked = { ...record, backupPath: backup, recoveryWarning: warning };
    const flat = join(dirname(path), record.name + '.md');
    if (await exists(flat)) return blocked;
    let settled = previous;
    if (saved) {
      if (!await matchesPackage(join(backup, 'SKILL.md'), update.currentVersion)) return blocked;
      if (!current) await rename(backup, path);
      else if (await matchesPackage(join(path, 'SKILL.md'), update.remoteVersion)) {
        settled = updatedRecord(previous, update, backup);
      } else return blocked;
    } else if (!await matchesPackage(join(path, 'SKILL.md'), update.currentVersion)) {
      return blocked;
    }
    await save('installations', record.id, settled);
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    return settled;
  }
  async function reconcile(record) {
    const path = await recordPath(record);
    if (record.operation === 'update') return reconcileUpdate(record, path);
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
  async function resolveRouteSkill({ libraryId, skillId, name, expectedPath, cwd, scope, signal, invocation = 'modelInvocable' }) {
    signal?.throwIfAborted();
    const entry = await skills.get(name, { cwd, scope, signal });
    signal?.throwIfAborted();
    const blocked = code => ({ entry: entry ?? null, effectivePath: null, code });
    if (!entry) return blocked('native_missing');
    if (!['modelInvocable', 'userInvocable'].includes(invocation) || !entry.invocation?.[invocation]) {
      return blocked('native_not_invocable');
    }
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) ||
      typeof expectedPath !== 'string' || !isAbsolute(expectedPath)) return blocked('native_path_mismatch');
    const found = effectivePath => ({ entry, effectivePath, code: null });
    if (samePath(entry.path, expectedPath)) return found(expectedPath);
    if (!validName(name) || !validOrigin({ libraryId, skillId })) return blocked('native_path_mismatch');
    const base = await realpath(home).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const personal = base && join(base, 'skills', name);
    if (!personal || !samePath(entry.path, join(personal, 'SKILL.md'))) return blocked('native_path_mismatch');
    const records = await personalOrigins(personal, name, { libraryId, skillId }, signal);
    if (!records.length) return blocked('installed_copy_unverified');
    const version = await sourcePackageVersion(expectedPath, signal).catch(() => {
      signal?.throwIfAborted();
      return null;
    });
    if (!version || !records.some(record => record.origin.version === version) || !await matchesPackage(entry.path, version, signal)) {
      return blocked('installed_copy_stale');
    }
    return found(entry.path);
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
  async function installRoot({ scope, managedId, sourcePath, path, projectRoot: project }) {
    if (scope === 'user') return directory(home, 'skills');
    if (scope === 'project') return directory(project, '.dsh', 'skills');
    return managedPath(managedId, sourcePath ?? (path && dirname(path)));
  }
  async function install(args, signal) {
    return mutate(async () => {
      signal?.throwIfAborted();
      const preview = await load('previews', args.previewId);
      if (!validName(preview.name)) throw new Error('技能名称无效。');
      if (!['user', 'project', 'managed'].includes(args.scope)) throw new Error('请选择技能安装位置。');
      const project = args.scope === 'project' ? await projectRoot(args.projectPath) : null;
      const parent = await installRoot({ scope: args.scope, projectRoot: project, managedId: args.managedId, sourcePath: args.sourcePath });
      const destination = join(parent, preview.name);
      const source = join(data, 'staging', preview.id, preview.name);
      let origin;
      if (preview.origin) {
        const { libraryId, skillId, version, sourcePath } = preview.origin;
        if (!validOrigin(preview.origin) || !await matchesPackage(sourcePath, version, signal) ||
          !await matchesPackage(join(source, 'SKILL.md'), version, signal)) {
          throw new Error('来源技能或预览中的技能包已改变，请重新预览。');
        }
        origin = { libraryId, skillId, version };
      }
      const flat = join(parent, `${preview.name}.md`);
      if (await exists(flat)) throw new Error(`同名技能已存在，未覆盖：${flat}`);
      if (await exists(destination)) {
        if (origin && args.scope === 'user') {
          const records = await personalOrigins(destination, preview.name, origin, signal);
          const reusable = records.find(record => record.origin.version === origin.version);
          if (reusable && await matchesPackage(join(destination, 'SKILL.md'), origin.version, signal)) {
            return { ...reusable, reused: true, native: await verify(reusable, signal, true) };
          }
        }
        throw new Error(`同名技能已存在，未覆盖：${destination}`);
      }
      const detail = await run({ action: 'check', path: source }, signal);
      if (!detail.validation.valid) throw new Error(detail.validation.errors.join('\n'));
      signal?.throwIfAborted();
      const record = { id: randomUUID(), name: detail.name, description: detail.metadata.description, catalog: preview.catalog, url: preview.url, path: destination, projectRoot: project, scope: args.scope, ...(args.scope === 'managed' && { managedId: args.managedId }), ...(origin && { origin }), installedAt: new Date().toISOString(), state: 'installed' };
      const pending = join(parent, `.skillnet-pending-${record.id}`);
      try {
        await cp(source, pending, { recursive: true, errorOnExist: true, force: false });
        if (origin && (!await matchesPackage(join(pending, 'SKILL.md'), origin.version, signal) ||
          !await matchesPackage(preview.origin.sourcePath, origin.version, signal))) {
          throw new Error('来源技能或预览中的技能包已改变，请重新预览。');
        }
        if (hasRemoteSource(record.url)) record.packageVersion = await sourcePackageVersion(join(pending, 'SKILL.md'), signal);
        signal?.throwIfAborted();
        if (await exists(destination) || await exists(flat)) throw new Error('安装期间出现同名技能，已保留现有文件。');
        await rename(pending, destination);
        try { await save('installations', record.id, record); }
        catch (error) { await rename(destination, pending); throw error; }
      } finally { await rm(pending, { recursive: true, force: true }); }
      // Publication has completed; cancellation must not hide the committed result.
      return { ...record, native: await verify(record, undefined, record.scope !== 'managed') };
    });
  }
  async function records() {
    const records = [], warnings = [];
    for (const name of await installationFiles()) {
      try { records.push(await reconcile(await load('installations', name.slice(0, -5)))); }
      catch { warnings.push(`安装记录无法读取：${name}`); }
    }
    return { records, warnings };
  }
  async function list(args = {}, signal, scope) {
    const { records: all, warnings } = await mutate(records);
    const installed = await Promise.all(all.map(async record => {
      const existsAsPackage = record.state === 'installed' && (await exists(record.path))?.isDirectory() &&
        (await exists(join(record.path, 'SKILL.md')))?.isFile();
      return { ...record, exists: Boolean(existsAsPackage), native: existsAsPackage ? await verify(record, signal, false, args.cwd, scope) : null };
    }));
    const snapshot = await skills.snapshot({ cwd: args.cwd || undefined, signal, scope });
    return { installed: installed.sort((a, b) => b.installedAt.localeCompare(a.installedAt)), catalog: snapshot.skills, complete: snapshot.complete, home, warnings };
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
    const invalid = () => new Error('请选择技能包内的文件。');
    if (typeof args.file !== 'string' || !args.file || args.file.includes('\0')) throw invalid();
    signal?.throwIfAborted();
    const root = await realpath(path);
    const target = await realpath(resolve(root, args.file)).catch(error => {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw invalid();
      throw error;
    });
    const location = relative(root, target);
    if (!location || location === '..' || location.startsWith('..' + sep) || isAbsolute(location) || !(await stat(target)).isFile()) throw invalid();
    const limit = 256 * 1024;
    const buffer = Buffer.alloc(limit + 1);
    const handle = await open(target, 'r');
    let length = 0;
    try {
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    const truncated = length > limit;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, Math.min(length, limit))); }
    catch { return { file: args.file, binary: true, text: '', truncated }; }
    return text.includes('\0') ? { file: args.file, binary: true, text: '', truncated } : { file: args.file, binary: false, text, truncated };
  }
  async function remove(args) {
    return mutate(async () => {
      const record = await reconcile(await load('installations', args.id));
      if (record.operation === 'update') throw new Error(record.recoveryWarning);
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
  async function updateTarget(id, signal) {
    signal?.throwIfAborted();
    const record = await reconcile(await load('installations', id));
    if (record.id !== id || record.state !== 'installed') throw new Error('此安装已移除或记录已改变。');
    if (record.operation) throw new Error(record.recoveryWarning || '此安装还有未完成的操作。');
    if (!hasRemoteSource(record.url)) throw new Error('这个技能没有可重新读取的 GitHub 来源。');
    const path = await recordPath(record);
    const flat = join(dirname(path), record.name + '.md');
    if (await exists(flat)) throw new Error('安装位置存在同名技能，已保留现有文件。');
    const matches = await trackedInstallations(path, signal);
    if (matches.length !== 1 || matches[0].id !== id) throw new Error('安装位置对应多个记录，已保留现有文件。');
    return { record, path, flat };
  }
  async function previewUpdate(args, signal) {
    const { record, path } = await mutate(() => updateTarget(args.id, signal));
    const current = await packageSnapshot(join(path, 'SKILL.md'), signal, true);
    const previewId = randomUUID();
    const root = await directory(home, 'skillnet', 'update-staging', previewId);
    let keep = false;
    try {
      // Pass the stored URL verbatim. A pinned commit remains pinned, and a
      // mutable reference only provides bytes for this explicitly staged preview.
      const detail = await run({ action: 'inspect', url: record.url, target_dir: root }, signal);
      if (detail.name !== record.name || !detail.validation.valid) throw new Error('远端技能的名称或结构已改变，不能覆盖当前技能。');
      const remote = await packageSnapshot(join(root, record.name, 'SKILL.md'), signal, true);
      const comparison = {
        id: record.id, name: record.name, url: record.url, targetPath: path,
        currentVersion: current.version, remoteVersion: remote.version,
        currentSource: current.source, remoteSource: remote.source, changes: packageChanges(current, remote),
      };
      if (record.packageVersion && record.packageVersion !== current.version) {
        return { ...comparison, status: 'blocked', code: 'local_modified', message: '本地技能包已有修改，已保留现有文件。' };
      }
      if (current.version === remote.version) {
        if (!record.packageVersion) await mutate(async () => {
          // A legacy installation can establish a baseline once the same
          // source is proven byte-for-byte. This writes no package files.
          const latest = await updateTarget(record.id, signal);
          if (latest.record.url !== record.url || !samePath(latest.path, path) ||
            (latest.record.packageVersion && latest.record.packageVersion !== current.version) ||
            !await matchesPackage(join(latest.path, 'SKILL.md'), current.version, signal)) {
            throw new Error('安装记录或技能包已改变，请重新检查更新。');
          }
          if (!latest.record.packageVersion) {
            await save('installations', record.id, { ...latest.record, packageVersion: current.version });
          }
        });
        return { ...comparison, status: 'unchanged' };
      }
      if (!record.packageVersion) return { ...comparison, status: 'blocked', code: 'baseline_unknown',
        message: '旧安装没有已验证的版本基准，无法区分本地修改和远端变化。已保留现有文件。' };
      signal?.throwIfAborted();
      const { currentVersion, remoteVersion } = comparison;
      await save('update-previews', previewId, { id: previewId, installationId: record.id, url: record.url, path, currentVersion, remoteVersion });
      keep = true;
      return { ...comparison, status: 'ready', previewId };
    } finally {
      if (!keep) await rm(root, { recursive: true, force: true });
    }
  }
  async function applyUpdate(args, signal) {
    return mutate(async () => {
      const { record, path, flat } = await updateTarget(args.id, signal);
      const preview = await load('update-previews', args.previewId);
      if (preview.id !== args.previewId || preview.installationId !== record.id ||
        preview.url !== record.url || !samePath(preview.path, path)) throw new Error('更新预览与当前安装不一致。');
      if (record.packageVersion !== preview.currentVersion ||
        !await matchesPackage(join(path, 'SKILL.md'), preview.currentVersion, signal)) {
        throw new Error('安装后的技能包已改变，请重新检查更新。');
      }
      const root = join(data, 'update-staging', preview.id);
      const source = join(root, record.name);
      if (!await matchesPackage(join(source, 'SKILL.md'), preview.remoteVersion, signal)) {
        throw new Error('远端预览中的技能包已改变，请重新检查更新。');
      }
      const detail = await run({ action: 'check', path: source }, signal);
      if (detail.name !== record.name || !detail.validation.valid) throw new Error('远端预览未通过结构校验。');
      const { backup, incoming } = await updatePaths(record, preview.id);
      if (await exists(backup) || await exists(incoming)) throw new Error('更新暂存位置已有文件，请重新检查更新。');
      const pending = join(incoming, record.name);
      const update = { previewId: preview.id, currentVersion: preview.currentVersion, remoteVersion: preview.remoteVersion,
        description: detail.metadata.description, updatedAt: new Date().toISOString() };
      const updated = updatedRecord(record, update, backup);
      await mkdir(incoming);
      try {
        await cp(source, pending, { recursive: true, errorOnExist: true, force: false });
        if (!await matchesPackage(join(pending, 'SKILL.md'), update.remoteVersion, signal) ||
          !await matchesPackage(join(path, 'SKILL.md'), update.currentVersion, signal) || await exists(flat)) {
          throw new Error('技能包或安装位置在更新期间已改变，已保留现有文件。');
        }
        signal?.throwIfAborted();
        // Finish publication or rollback once the journal is on disk, even
        // if the caller closes the preview while the two renames are in flight.
        await save('installations', record.id, { ...record, operation: 'update', pendingUpdate: update });
        let backedUp = false;
        let published = false;
        try {
          await rename(path, backup);
          backedUp = true;
          if (await exists(path) || await exists(flat) ||
            !await matchesPackage(join(backup, 'SKILL.md'), update.currentVersion)) {
            throw new Error('安装位置或旧技能在替换期间已改变，已保留现有文件。');
          }
          await rename(pending, path);
          published = true;
          await save('installations', record.id, updated);
        } catch (error) {
          try {
            if (published) {
              if (!await matchesPackage(join(path, 'SKILL.md'), update.remoteVersion)) throw new Error('安装位置已改变。');
              await rename(path, pending);
            }
            if (backedUp) {
              if (await exists(path) || await exists(flat) || !(await exists(backup))?.isDirectory()) throw new Error('备份或安装位置已改变。');
              await rename(backup, path);
            }
            await save('installations', record.id, record);
          } catch {
            throw new Error(`更新未能恢复，请检查安装位置与旧版本备份：${backup}`, { cause: error });
          }
          throw error;
        }
      } finally {
        await rm(incoming, { recursive: true, force: true }).catch(() => {});
      }
      await rm(root, { recursive: true, force: true }).catch(() => {});
      return updated;
    });
  }
  async function prepareLocal(path, signal, origin) {
    signal?.throwIfAborted();
    const checked = origin ? null : await run({ action: 'check', path }, signal);
    const name = checked?.name ?? basename(path);
    if (!validName(name) || (checked && !checked.validation.valid)) throw new Error('草稿未通过官方结构校验。');
    if (origin && (!validOrigin(origin) || origin.skillId !== name)) throw new Error('来源技能标识无效。');
    const sourcePath = join(path, 'SKILL.md');
    const provenance = origin && {
      libraryId: origin.libraryId, skillId: origin.skillId,
      sourcePath, version: await sourcePackageVersion(sourcePath, signal),
    };
    const id = randomUUID();
    const root = await directory(home, 'skillnet', 'staging', id);
    try {
      const staged = join(root, name);
      await cp(path, staged, { recursive: true, dereference: false });
      if (provenance && !await matchesPackage(join(staged, 'SKILL.md'), provenance.version, signal)) {
        throw new Error('来源技能包在预览期间已改变，请重新预览。');
      }
      const detail = checked || await run({ action: 'check', path: staged }, signal);
      if (detail.name !== name || !detail.validation.valid) throw new Error('来源技能未通过官方结构校验。');
      signal?.throwIfAborted();
      await save('previews', id, { id, url: null, name, catalog: null, preparedAt: new Date().toISOString(), ...(provenance && { origin: provenance }) });
      return { ...detail, previewId: id };
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  return { home, createManaged, prepare, prepareLocal, sourcePackageVersion, resolveRouteSkill, install, list, inspectInstalled, file,
    remove, restore, previewUpdate, applyUpdate,
    verify: async (args, signal) => verify(await installation(args.id), signal, true, args.cwd) };
}
