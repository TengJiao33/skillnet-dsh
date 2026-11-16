import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createBackend } from '../src/backend.js';
import { apply } from '../src/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-reader-'));
  const children = [];
  const subprocess = {
    resolveExecutable: async value => value,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, env: { ...process.env, ...spec.env, SKILLNET_CONFIG: join(root, 'no-user-config.json') },
        stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal,
      });
      children.push(child);
      child.firstOutput = new Promise(resolve => child.stdout.once('data', resolve));
      child.stderr.resume();
      const exited = new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
      const done = new Promise((resolve, reject) => { child.on('error', reject); exited.then(resolve); });
      return { stdin: child.stdin, stdout: child.stdout, done,
        terminate: async () => { if (child.exitCode === null) child.kill(); }, waitForExit: () => exited };
    },
  };
  const backend = createBackend(subprocess);
  t.after(async () => { await backend.dispose(); await rm(root, { recursive: true, force: true }); });
  async function skill(library, name, description = 'Read current files.') {
    const path = join(library, name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nRead the supplied data.\n`);
  }
  const sourcePath = join(root, 'skills');
  await skill(sourcePath, 'reader-first');
  const read = (path = sourcePath, signal) => backend({ action: 'local-library', sourcePath: path }, signal);
  return { root, sourcePath, backend, children, skill, read, subprocess };
}

test('warm SDK reader reopens libraries and observes edits, added skills and removals without caching results', async t => {
  const f = await fixture(t);
  assert.equal((await f.read()).analysisStatus, 'missing');
  await f.skill(f.sourcePath, 'reader-first', 'Updated description.');
  await f.skill(f.sourcePath, 'reader-added');
  const updated = await f.read();
  assert.equal(updated.source.skills.find(skill => skill.name === 'reader-first').description, 'Updated description.');
  assert.equal(updated.source.skills.length, 2);
  await unlink(join(f.sourcePath, 'reader-first', 'SKILL.md'));
  assert.deepEqual((await f.read()).source.skills.map(skill => skill.name), ['reader-added']);
  assert.equal(f.children.length, 1);
});

test('plugin startup warms the SDK before opening its panel and reuses that reader for the first request', async t => {
  const f = await fixture(t);
  const disposers = [], handlers = new Map();
  const ctx = {
    subprocess: f.subprocess,
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(spec) { handlers.set(spec.path, spec); return () => handlers.delete(spec.path); } } },
    jobs: { attachController: () => () => {} },
    tools: { register() {} }, skills: { register() {} }, systemPrompt: { section() {} },
    credentials: { resolve() { throw new Error('Browsing must not resolve credentials'); } },
  };
  try {
    apply(ctx, { dshHome: f.root });
    while (!f.children.length) await setTimeout(5);
    await f.children[0].firstOutput;
    const reply = await handlers.get('/api/skillnet/workspace-read').fetch(new Request('http://localhost/api/skillnet/workspace-read', { method: 'POST', body: JSON.stringify({ sourcePath: f.sourcePath }) }));
    const result = await reply.json();
    assert.equal(result.ok, true);
    assert.equal(result.data.source.skills[0].name, 'reader-first');
    assert.equal(f.children.length, 1);
  } finally { for (const dispose of disposers.reverse()) await dispose(); }
});

test('concurrent reads stay paired, queued cancellation is isolated, and invalid paths do not discard the warm SDK', async t => {
  const f = await fixture(t);
  const other = join(f.root, 'other'); await f.skill(other, 'reader-other');
  const first = f.read();
  const cancel = new AbortController();
  const cancelled = assert.rejects(f.read(f.sourcePath, cancel.signal), { name: 'AbortError' });
  cancel.abort(); await cancelled;
  const second = f.read(other);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.source.skills[0].name, 'reader-first');
  assert.equal(b.source.skills[0].name, 'reader-other');
  await assert.rejects(f.read(join(f.root, 'missing')));
  assert.equal((await f.read()).source.skills[0].name, 'reader-first');
  assert.equal(f.children.length, 1);
});

test('active cancellation and an exited reader recover on the next read; disposal releases the process', async t => {
  const f = await fixture(t);
  const cancel = new AbortController();
  const cancelled = assert.rejects(f.read(f.sourcePath, cancel.signal), { name: 'AbortError' });
  while (!f.children.length) await setTimeout(5);
  await setTimeout(10); cancel.abort(); await cancelled;
  assert.equal((await f.read()).source.skills.length, 1);
  assert.equal(f.children.length, 2);
  const stopped = new Promise(resolve => f.children[1].once('close', resolve));
  f.children[1].kill(); await stopped;
  assert.equal((await f.read()).source.skills.length, 1);
  assert.equal(f.children.length, 3);
  await f.backend.dispose();
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(f.read(), /插件已停止/);
});
