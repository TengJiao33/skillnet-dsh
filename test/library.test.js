import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLibrary, projectRoot } from '../src/library.js';
import { createWorkspace } from '../src/workspace.js';
import { pythonExecutable } from '../src/backend.js';

test('personal storage resolves from explicit configuration, DSH_HOME or the current user home', () => {
  const previous = process.env.DSH_HOME;
  try {
    const environmentHome = join(tmpdir(), 'dsh-custom-data-home');
    const configuredHome = join(tmpdir(), 'dsh-explicit-data-home');
    process.env.DSH_HOME = `  ${environmentHome}  `;
    assert.equal(createLibrary(null, {}).home, environmentHome);
    assert.equal(createLibrary(null, {}, { dshHome: configuredHome }).home, configuredHome);
    process.env.DSH_HOME = '   ';
    assert.equal(createLibrary(null, {}).home, join(homedir(), '.dsh'));
    assert.equal(createLibrary(null, {}, { dshHome: '~/.dsh-custom' }).home, join(homedir(), '.dsh-custom'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

const worker = fileURLToPath(new URL('../python/worker.py', import.meta.url));
function sdk(request) {
  const result = spawnSync(pythonExecutable(), [worker], { input: JSON.stringify(request), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.error, undefined);
  const value = JSON.parse(result.stdout);
  if (!value.ok) throw new Error(value.error.message);
  return value.data;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skillnet-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const source = join(root, 'source', 'fixture-skill');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Test fixture instructions\n---\n# Fixture\nRead scripts/helper.txt when needed.\n');
  await writeFile(join(source, 'scripts', 'helper.txt'), 'original helper');
  const calls = [];
  const run = async request => {
    calls.push(request.action);
    if (request.action === 'inspect') { const destination = join(request.target_dir, 'fixture-skill'); await cp(source, destination, { recursive: true }); return sdk({ action: 'check', path: destination }); }
    return sdk(request);
  };
  const skills = {
    async get(name, options = {}) {
      const roots = options.cwd ? [join(await projectRoot(options.cwd), '.dsh', 'skills'), join(home, 'skills')] : [join(home, 'skills')];
      for (const parent of roots) {
        try {
          const path = join(parent, name, 'SKILL.md'); const content = await readFile(path, 'utf8');
          return { name, path, content, source: parent.startsWith(home) ? 'user-dsh' : 'project-dsh', invocation: { modelInvocable: true, userInvocable: true } };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
    async snapshot(options) { const found = await this.get('fixture-skill', options); return { skills: found ? [found] : [], complete: true }; },
  };
  return { root, home, source, run, skills, calls, library: createLibrary(run, skills, { dshHome: home }) };
}

test('complete package installs, persists and preserves local edits through remove/restore', async t => {
  const f = await fixture(t);
  const preview = await f.library.prepare({ url: 'fixture://source' });
  assert.deepEqual(preview.files, ['SKILL.md', 'scripts/helper.txt']);
  const record = await f.library.install({ previewId: preview.previewId, scope: 'user' });
  assert.equal(record.native.effective, true);
  assert.equal(await readFile(join(record.path, 'scripts/helper.txt'), 'utf8'), 'original helper');
  assert.deepEqual(await f.library.file({ id: record.id, file: 'scripts/helper.txt' }), { file: 'scripts/helper.txt', text: 'original helper', binary: false, truncated: false });
  await assert.rejects(f.library.file({ id: record.id, file: '../../outside.txt' }), /技能包内的文件/);
  const support = join(record.path, 'scripts/helper.txt');
  await writeFile(support, Buffer.alloc(256 * 1024 + 1, 65));
  const full = await f.library.file({ id: record.id, file: 'scripts/helper.txt' });
  assert.equal(full.truncated, true);
  assert.equal(full.text.length, 256 * 1024);
  await writeFile(support, Buffer.of(0xFF));
  assert.equal((await f.library.file({ id: record.id, file: 'scripts/helper.txt' })).binary, true);
  await writeFile(join(record.path, 'scripts/helper.txt'), 'user edit');
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'user' }), /同名/);
  const reopened = createLibrary(f.run, f.skills, { dshHome: f.home });
  assert.equal((await reopened.list()).installed[0].id, record.id);
  await reopened.remove({ id: record.id });
  assert.equal((await reopened.list()).installed[0].state, 'removed');
  await assert.rejects(reopened.file({ id: record.id, file: 'SKILL.md' }), /已移除/);
  await reopened.restore({ id: record.id });
  assert.equal(await readFile(join(record.path, 'scripts/helper.txt'), 'utf8'), 'user edit');
});

test('installation inventory requires SKILL.md and keeps removed records available for restoration', async t => {
  const f = await fixture(t);
  const preview = await f.library.prepare({ url: 'fixture://source' });
  const record = await f.library.install({ previewId: preview.previewId, scope: 'user' });
  const marker = join(record.path, 'SKILL.md');
  const displaced = join(record.path, 'instructions.txt');
  await rename(marker, displaced);
  const incomplete = (await f.library.list()).installed[0];
  assert.equal(incomplete.state, 'installed');
  assert.equal(incomplete.exists, false);
  assert.equal(incomplete.native, null);
  await rename(displaced, marker);
  assert.equal((await f.library.list()).installed[0].exists, true);
  await f.library.remove({ id: record.id });
  await cp(f.source, record.path, { recursive: true });
  const removed = (await f.library.list()).installed[0];
  assert.equal(removed.state, 'removed');
  assert.equal(removed.exists, false);
  await assert.rejects(f.library.restore({ id: record.id }), /不会覆盖/);
  assert.equal(await readFile(join(record.path, 'scripts', 'helper.txt'), 'utf8'), 'original helper');
});

const remoteBranch = 'https://github.com/example/skills/tree/main/fixture-skill';
const remoteCommit = 'https://github.com/example/skills/tree/0123456789abcdef0123456789abcdef01234567/fixture-skill';

async function remoteInstallation(f, url = remoteBranch) {
  const requests = [];
  const run = async (request, signal) => {
    requests.push(request);
    return f.run(request, signal);
  };
  const library = createLibrary(run, f.skills, { dshHome: f.home });
  const preview = await library.prepare({ url });
  const record = await library.install({ previewId: preview.previewId, scope: 'user' });
  const metadata = join(f.home, 'skillnet', 'installations', record.id + '.json');
  return { library, record, requests, metadata };
}

test('remote update previews the complete package and publishes the exact confirmed bytes with a backup', async t => {
  const f = await fixture(t);
  const { library, record, requests } = await remoteInstallation(f);
  const installed = join(record.path, 'SKILL.md');
  const marker = join(f.source, 'SKILL.md');
  const original = await readFile(marker, 'utf8');
  const replacement = original.replace('Test fixture instructions', 'Updated fixture instructions');
  assert.equal(record.packageVersion, await library.sourcePackageVersion(installed));
  await writeFile(marker, replacement);
  await rename(join(f.source, 'scripts', 'helper.txt'), join(f.source, 'scripts', 'new-helper.txt'));
  const preview = await library.previewUpdate({ id: record.id });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.url, remoteBranch);
  assert.equal(preview.targetPath, record.path);
  assert.equal(preview.currentSource, original);
  assert.equal(preview.remoteSource, replacement);
  assert.deepEqual(preview.changes, [
    { path: 'SKILL.md', kind: 'modified' },
    { path: 'scripts/helper.txt', kind: 'removed' },
    { path: 'scripts/new-helper.txt', kind: 'added' },
  ]);
  assert.equal(await readFile(installed, 'utf8'), original);

  await writeFile(marker, replacement + '\nRemote changed again.\n');
  const confirm = { id: record.id, previewId: preview.previewId };
  const [first, second] = await Promise.allSettled([library.applyUpdate(confirm), library.applyUpdate(confirm)]);
  assert.equal(first.status, 'fulfilled', first.reason?.stack);
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /已改变/);
  const updated = first.value;
  assert.equal(updated.id, record.id);
  assert.equal(updated.url, remoteBranch);
  assert.equal(updated.description, 'Updated fixture instructions');
  assert.equal(updated.packageVersion, preview.remoteVersion);
  assert.equal(await readFile(installed, 'utf8'), replacement);
  assert.equal(await readFile(join(updated.backupPath, 'SKILL.md'), 'utf8'), original);
  assert.equal(await readFile(join(updated.backupPath, 'scripts', 'helper.txt'), 'utf8'), 'original helper');
  assert.deepEqual(requests.filter(request => request.action === 'inspect').map(request => request.url), [remoteBranch, remoteBranch]);
});

test('fixed commits stay fixed and legacy baselines require byte-for-byte agreement', async t => {
  const f = await fixture(t);
  const { library, record, requests, metadata } = await remoteInstallation(f, remoteCommit);
  const { packageVersion, ...legacy } = JSON.parse(await readFile(metadata, 'utf8'));
  await writeFile(metadata, JSON.stringify(legacy));
  const helper = join(record.path, 'scripts', 'helper.txt');
  await writeFile(helper, 'unverified local change');
  const blocked = await library.previewUpdate({ id: record.id });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'baseline_unknown');
  assert.equal(blocked.previewId, undefined);
  assert.equal(await readFile(helper, 'utf8'), 'unverified local change');
  await writeFile(helper, 'original helper');
  const comparison = await library.previewUpdate({ id: record.id });
  assert.equal(comparison.status, 'unchanged');
  assert.deepEqual(comparison.changes, []);
  assert.equal(comparison.previewId, undefined);
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).packageVersion, packageVersion);
  assert.deepEqual(requests.filter(request => request.action === 'inspect').map(request => request.url), [remoteCommit, remoteCommit, remoteCommit]);
});

test('remote update refuses changes to the local package, preview, install record and name ownership', async t => {
  const f = await fixture(t);
  const { library, record, metadata } = await remoteInstallation(f);
  await writeFile(join(f.source, 'scripts', 'helper.txt'), 'remote helper');
  const request = { id: record.id };
  const { previewId } = await library.previewUpdate(request);
  const apply = { ...request, previewId };
  const installedHelper = join(record.path, 'scripts', 'helper.txt');
  await writeFile(installedHelper, 'latest user edit');
  await assert.rejects(library.applyUpdate(apply), /已改变/);
  const blocked = await library.previewUpdate(request);
  assert.equal(blocked.code, 'local_modified');
  assert.equal(await readFile(installedHelper, 'utf8'), 'latest user edit');
  await writeFile(installedHelper, 'original helper');

  const flat = record.path + '.md';
  await writeFile(flat, 'manual same-name skill');
  await assert.rejects(library.applyUpdate(apply), /同名/);
  assert.equal(await readFile(flat, 'utf8'), 'manual same-name skill');
  await rm(flat);
  const duplicate = { ...JSON.parse(await readFile(metadata, 'utf8')), id: randomUUID() };
  const duplicatePath = join(metadata, '..', duplicate.id + '.json');
  await writeFile(duplicatePath, JSON.stringify(duplicate));
  await assert.rejects(library.applyUpdate(apply), /多个记录/);
  await rm(duplicatePath);

  const outside = join(f.root, 'outside');
  await mkdir(outside);
  const linked = join(record.path, 'references');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.applyUpdate(apply), /已改变/);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  await rm(linked);

  const stagedHelper = join(f.home, 'skillnet', 'update-staging', previewId, record.name, 'scripts', 'helper.txt');
  await writeFile(stagedHelper, 'unexpected preview edit');
  await assert.rejects(library.applyUpdate(apply), /远端预览.*已改变/);
  assert.equal(await readFile(installedHelper, 'utf8'), 'original helper');
  await library.remove(request);
  await assert.rejects(library.applyUpdate(apply), /已移除/);
});

test('update journal restores an interrupted backup and preserves both copies if another package occupies the path', async t => {
  const f = await fixture(t);
  const { library, record, metadata } = await remoteInstallation(f);
  await writeFile(join(f.source, 'scripts', 'helper.txt'), 'remote helper');
  const preview = await library.previewUpdate({ id: record.id });
  const data = JSON.parse(await readFile(metadata, 'utf8'));
  const interrupted = { ...data, operation: 'update', pendingUpdate: {
    previewId: preview.previewId, currentVersion: preview.currentVersion, remoteVersion: preview.remoteVersion,
    description: record.description, updatedAt: new Date().toISOString(),
  } };
  const backup = join(f.home, 'skillnet', 'versions', record.id, preview.previewId, record.name);
  await mkdir(join(backup, '..'), { recursive: true });
  await writeFile(metadata, JSON.stringify(interrupted));
  await rename(record.path, backup);
  const reopened = createLibrary(f.run, f.skills, { dshHome: f.home });
  const repaired = (await reopened.list()).installed[0];
  assert.equal(repaired.packageVersion, preview.currentVersion);
  assert.equal(repaired.operation, undefined);
  assert.equal(await readFile(join(record.path, 'scripts', 'helper.txt'), 'utf8'), 'original helper');

  await writeFile(metadata, JSON.stringify(interrupted));
  await rename(record.path, backup);
  await cp(f.source, record.path, { recursive: true });
  const helper = join(record.path, 'scripts', 'helper.txt');
  await writeFile(helper, 'another local package');
  const conflict = (await reopened.list()).installed[0];
  assert.equal(conflict.operation, 'update');
  assert.match(conflict.recoveryWarning, /路径冲突/);
  await assert.rejects(reopened.remove({ id: record.id }), /尚未恢复/);
  assert.equal(await readFile(helper, 'utf8'), 'another local package');
  assert.equal(await readFile(join(backup, 'scripts', 'helper.txt'), 'utf8'), 'original helper');

  await writeFile(helper, 'remote helper');
  const completed = (await reopened.list()).installed[0];
  assert.equal(completed.operation, undefined);
  assert.equal(completed.packageVersion, preview.remoteVersion);
  assert.equal(completed.backupPath, backup);
});

test('scoped resolution keeps the original path and checks the requested native permission', async t => {
  const f = await fixture(t);
  const cwd = f.root;
  const scope = { id: 'chat' };
  const signal = new AbortController().signal;
  const expectedPath = join(f.source, 'SKILL.md');
  const entry = { path: expectedPath, invocation: { modelInvocable: false, userInvocable: true } };
  const registry = { async get(name, options) {
    assert.equal(name, 'fixture-skill');
    assert.deepEqual(options, { cwd, scope, signal });
    return entry;
  } };
  const library = createLibrary(f.run, registry, { dshHome: f.home });
  const args = { libraryId: randomUUID(), skillId: 'fixture-skill', name: 'fixture-skill', expectedPath, cwd, scope, signal };
  assert.deepEqual(await library.resolveRouteSkill(args), { entry, effectivePath: null, code: 'native_not_invocable' });
  assert.deepEqual(await library.resolveRouteSkill({ ...args, invocation: 'userInvocable' }), { entry, effectivePath: expectedPath, code: null });
});

test('route-origin installation proves the complete current package and reuses the same installation', async t => {
  const f = await fixture(t);
  const origin = { libraryId: randomUUID(), skillId: 'fixture-skill' };
  const expectedPath = join(f.source, 'SKILL.md');
  const args = { ...origin, name: 'fixture-skill', expectedPath };
  assert.equal((await f.library.resolveRouteSkill(args)).code, 'native_missing');
  const preview = await f.library.prepareLocal(f.source, undefined, origin);
  const install = { previewId: preview.previewId, scope: 'user' };
  const record = await f.library.install(install);
  assert.deepEqual(record.origin, { ...origin, version: await f.library.sourcePackageVersion(expectedPath) });
  const reopened = createLibrary(f.run, f.skills, { dshHome: f.home });
  const matched = await reopened.resolveRouteSkill(args);
  assert.equal(matched.code, null);
  assert.equal(matched.effectivePath, join(record.path, 'SKILL.md'));
  assert.equal((await reopened.resolveRouteSkill({ ...args, libraryId: randomUUID() })).code, 'installed_copy_unverified');
  assert.equal((await reopened.resolveRouteSkill({ ...args, skillId: 'different-skill' })).code, 'installed_copy_unverified');
  const repeat = await reopened.install(install);
  assert.equal(repeat.id, record.id);
  assert.equal(repeat.reused, true);
  assert.equal((await reopened.list()).installed.length, 1);
  await reopened.remove({ id: record.id });
  assert.equal((await reopened.resolveRouteSkill(args)).code, 'native_missing');
  await reopened.restore({ id: record.id });
  assert.equal((await reopened.resolveRouteSkill(args)).code, null);
  const cwd = join(f.root, 'project');
  const shadow = join(cwd, '.dsh', 'skills', 'fixture-skill');
  await cp(f.source, shadow, { recursive: true });
  const shadowed = await reopened.resolveRouteSkill({ ...args, cwd });
  assert.equal(shadowed.code, 'native_path_mismatch');
  assert.equal(shadowed.entry.path, join(shadow, 'SKILL.md'));
  const installedHelper = join(record.path, 'scripts', 'helper.txt');
  await writeFile(installedHelper, 'changed installed helper');
  assert.equal((await reopened.resolveRouteSkill(args)).code, 'installed_copy_stale');
  await assert.rejects(reopened.install(install), /同名/);
  assert.equal(await readFile(installedHelper, 'utf8'), 'changed installed helper');
  await writeFile(installedHelper, 'original helper');
  await writeFile(join(f.source, 'scripts', 'helper.txt'), 'changed source helper');
  assert.equal((await reopened.resolveRouteSkill(args)).code, 'installed_copy_stale');
  await assert.rejects(reopened.install(install), /重新预览/);
  assert.equal(await readFile(installedHelper, 'utf8'), 'original helper');
});

test('identical untracked and different-origin personal packages never qualify as route copies', async t => {
  const f = await fixture(t);
  const original = await f.library.prepare({ url: 'fixture://source' });
  const legacy = await f.library.install({ previewId: original.previewId, scope: 'user' });
  const origin = { libraryId: randomUUID(), skillId: 'fixture-skill' };
  const args = { ...origin, name: 'fixture-skill', expectedPath: join(f.source, 'SKILL.md') };
  const preview = await f.library.prepareLocal(f.source, undefined, origin);
  const request = { previewId: preview.previewId, scope: 'user' };
  assert.equal((await f.library.resolveRouteSkill(args)).code, 'installed_copy_unverified');
  await assert.rejects(f.library.install(request), /同名/);
  await f.library.remove({ id: legacy.id });
  const differentOrigin = await f.library.prepareLocal(f.source, undefined, { ...origin, libraryId: randomUUID() });
  const other = await f.library.install({ ...request, previewId: differentOrigin.previewId });
  assert.equal((await f.library.resolveRouteSkill(args)).code, 'installed_copy_unverified');
  await assert.rejects(f.library.install(request), /同名/);
  assert.equal(await readFile(join(other.path, 'scripts', 'helper.txt'), 'utf8'), 'original helper');
});

test('a route preview cannot publish altered staging or a linked package', async t => {
  const f = await fixture(t);
  const origin = { libraryId: randomUUID(), skillId: 'fixture-skill' };
  const preview = await f.library.prepareLocal(f.source, undefined, origin);
  const staged = join(f.home, 'skillnet', 'staging', preview.previewId, 'fixture-skill');
  await writeFile(join(staged, 'scripts', 'helper.txt'), 'edit after preview');
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'user' }), /重新预览/);
  assert.equal((await f.library.list()).installed.length, 0);
  const outside = join(f.root, 'unrelated');
  await mkdir(outside);
  await symlink(outside, join(f.source, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.library.prepareLocal(f.source, undefined, origin), /链接/);
  await assert.rejects(f.library.sourcePackageVersion(join(f.source, 'SKILL.md'), AbortSignal.abort()), { name: 'AbortError' });
});

test('named libraries keep their identity and install separately from the personal library', async t => {
  const f = await fixture(t);
  const run = async request => {
    assert.equal(request.action, 'local-library');
    return { source: { skills: [] }, graph: null };
  };
  const workspace = createWorkspace({}, run, f.library);
  const personal = (await workspace.connect(await workspace.config())).connection;
  const { connection: named } = await workspace.createNamed({ name: ' 论文工具 ' });
  assert.equal(named.name, '论文工具');
  assert.equal(named.sourcePath, join(f.home, 'skillnet', 'libraries', '论文工具', 'skills'));
  assert.equal((await workspace.installTargets()).currentId, named.id);
  await assert.rejects(workspace.createNamed({ name: '论文工具' }), /同名/);

  const { previewId } = await f.library.prepare({ url: 'fixture://source' });
  const addition = await workspace.install({ previewId, libraryId: named.id });
  assert.equal(addition.native.effective, false);
  assert.equal(addition.path, join(named.sourcePath, 'fixture-skill'));
  assert.equal(await readFile(join(addition.path, 'scripts/helper.txt'), 'utf8'), 'original helper');
  const readback = sdk({ action: 'local-library', sourcePath: named.sourcePath });
  assert.ok(readback.source.skills.some(skill => skill.id === 'fixture-skill'));
  await assert.rejects(lstat(join(personal.sourcePath, 'fixture-skill')), { code: 'ENOENT' });
  await assert.rejects(workspace.install({ previewId, libraryId: named.id }), /同名/);
  const nativeInstall = await workspace.install({ previewId, scope: 'user' });
  assert.equal(nativeInstall.native.effective, true);

  const reopenedLibrary = createLibrary(f.run, f.skills, { dshHome: f.home });
  const reopened = createWorkspace({}, run, reopenedLibrary);
  assert.deepEqual(await reopened.config(), { sourcePath: named.sourcePath });
  await reopened.forget({ libraryId: named.id });
  await assert.rejects(reopened.install({ previewId, libraryId: named.id }), /连接/);
  assert.equal((await lstat(addition.path)).isDirectory(), true);
  assert.deepEqual((await reopened.connect({ sourcePath: named.sourcePath })).connection, named);
  await reopenedLibrary.remove({ id: addition.id });
  await reopenedLibrary.restore({ id: addition.id });
  assert.equal(await readFile(join(addition.path, 'scripts/helper.txt'), 'utf8'), 'original helper');
  assert.equal((await lstat(nativeInstall.path)).isDirectory(), true);
});

test('managed folder names handle Windows characters, reserved names and existing folders', async t => {
  const f = await fixture(t);
  const root = join(f.home, 'skillnet', 'libraries');
  assert.equal(await f.library.createManaged('论文/图表'), join(root, '论文-图表', 'skills'));
  assert.equal(await f.library.createManaged('论文:图表'), join(root, '论文-图表-2', 'skills'));
  assert.equal(await f.library.createManaged('COM¹.txt'), join(root, '_COM¹.txt', 'skills'));
  const { name } = JSON.parse(await readFile(join(root, '论文-图表-2', 'library.json'), 'utf8'));
  assert.equal(name, '论文:图表');
});

test('existing ID folders and their installed skills remain usable', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const folder = join(f.home, 'skillnet', 'libraries', id);
  const sourcePath = join(folder, 'skills');
  const path = join(sourcePath, 'fixture-skill');
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(folder, 'name.txt'), '旧技能库');
  await cp(f.source, path, { recursive: true });
  const saved = { id: randomUUID(), name: 'fixture-skill', scope: 'managed', managedId: id, path, state: 'installed', installedAt: new Date().toISOString() };
  const installations = join(f.home, 'skillnet', 'installations');
  await mkdir(installations);
  await writeFile(join(installations, saved.id + '.json'), JSON.stringify(saved));
  const workspace = createWorkspace({}, async () => ({ source: { skills: [] }, graph: null }), f.library);
  const { connection } = await workspace.connect({ sourcePath });
  assert.equal(connection.id, id);
  assert.equal(connection.name, '旧技能库');
  assert.equal(connection.managed, true);
  assert.equal((await f.library.list()).installed[0].id, saved.id);
  await f.library.remove({ id: saved.id });
  await f.library.restore({ id: saved.id });
  assert.equal(await readFile(join(path, 'scripts/helper.txt'), 'utf8'), 'original helper');
});

test('project install uses nearest Git root and reports the native winner for same names', async t => {
  const f = await fixture(t); const project = join(f.root, 'project'); const child = join(project, 'src');
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(child);
  const preview = await f.library.prepare({ url: 'fixture://source' });
  const user = await f.library.install({ previewId: preview.previewId, scope: 'user' });
  const local = await f.library.install({ previewId: preview.previewId, scope: 'project', projectPath: child });
  assert.equal(local.path, join(await projectRoot(child), '.dsh', 'skills', 'fixture-skill'));
  assert.equal(local.native.effective, true);
  const rows = (await f.library.list({ cwd: child })).installed;
  assert.equal(rows.find(row => row.id === user.id).native.effective, false);
  assert.equal(rows.find(row => row.id === user.id).native.path, join(local.path, 'SKILL.md'));
  await f.library.remove({ id: local.id }); await f.library.restore({ id: local.id });
});

test('path traversal, linked install roots, and existing flat skills are rejected', async t => {
  const f = await fixture(t); const preview = await f.library.prepare({ url: 'fixture://source' });
  await assert.rejects(f.library.install({ previewId: '../outside', scope: 'user' }), /记录无效/);
  await assert.rejects(f.library.file({ previewId: preview.previewId, file: '../../../../../outside' }), /技能包内/);
  await mkdir(join(f.home, 'skills'), { recursive: true });
  await writeFile(join(f.home, 'skills', 'fixture-skill.md'), 'existing user file');
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'user' }), /同名/);
  assert.equal(await readFile(join(f.home, 'skills', 'fixture-skill.md'), 'utf8'), 'existing user file');
  const project = join(f.root, 'linked-project'); const outside = join(f.root, 'outside');
  await mkdir(join(project, '.dsh'), { recursive: true }); await mkdir(outside);
  await symlink(outside, join(project, '.dsh', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'project', projectPath: project }), /链接/);
});

test('cancelled writes do not publish and concurrent same-name installs do not overwrite', async t => {
  const f = await fixture(t); const preview = await f.library.prepare({ url: 'fixture://source' });
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'user' }, AbortSignal.abort()), /abort/i);
  assert.equal((await f.library.list()).installed.length, 0);
  const results = await Promise.allSettled([f.library.install({ previewId: preview.previewId, scope: 'user' }), f.library.install({ previewId: preview.previewId, scope: 'user' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.library.list()).installed.length, 1);
});

test('official SDK structural validation prevents publishing malformed skill instructions', async t => {
  const f = await fixture(t); const preview = await f.library.prepare({ url: 'fixture://source' });
  await writeFile(join(f.home, 'skillnet', 'staging', preview.previewId, 'fixture-skill', 'SKILL.md'), '---\nname: different-name\ndescription: invalid identity\n---\n');
  await assert.rejects(f.library.install({ previewId: preview.previewId, scope: 'user' }), /一致/);
  assert.equal((await f.library.list()).installed.length, 0);
});

test('restart reconciles interrupted removal and restoration without losing local edits', async t => {
  const f = await fixture(t);
  const preview = await f.library.prepare({ url: 'fixture://source' });
  const record = await f.library.install({ previewId: preview.previewId, scope: 'user' });
  await writeFile(join(record.path, 'scripts/helper.txt'), 'preserved edit');
  const backup = join(f.home, 'skillnet', 'removed', record.id, record.name);
  await mkdir(join(backup, '..'), { recursive: true });
  await rename(record.path, backup); // old-version crash between move and metadata commit
  let reopened = createLibrary(f.run, f.skills, { dshHome: f.home });
  const removed = (await reopened.list()).installed[0];
  assert.equal(removed.state, 'removed');
  await writeFile(join(f.home, 'skillnet/installations', record.id + '.json'), JSON.stringify({ ...removed, operation: 'restore' }));
  await rename(backup, record.path); // journalled restore crashes before metadata commit
  reopened = createLibrary(f.run, f.skills, { dshHome: f.home });
  assert.equal((await reopened.list()).installed[0].state, 'installed');
  assert.equal(await readFile(join(record.path, 'scripts/helper.txt'), 'utf8'), 'preserved edit');
  await reopened.remove({ id: record.id }); await reopened.restore({ id: record.id });
});
