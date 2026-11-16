import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLibrary, projectRoot } from '../src/library.js';
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
