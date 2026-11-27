import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createBackend } from '../src/backend.js';
import { apply } from '../src/index.js';
import { previewDocument } from '../src/document-preview.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-reader-'));
  const children = [];
  const subprocess = {
    resolveExecutable: async value => value,
    spawn(spec) {
      const env = { ...process.env, ...spec.env, SKILLNET_CONFIG: join(root, 'no-user-config.json') };
      delete env.EMBEDDING_API_KEY;
      delete env.GITHUB_TOKEN;
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, env,
        stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal,
      });
      children.push(child);
      child.workerArguments = spec.argv;
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
  const route = (invoke, options = {}) => backend({ action: 'route', retrievalMode: options.mode || 'model', sourcePath, indexPath: options.indexPath,
    query: options.query || 'Find a data inspection skill.', k: 1, _settings: options.settings || {},
    _host_model: { provider: 'fixture', model: options.model || 'fixture-model' },
  }, options.signal, invoke);
  return { root, sourcePath, backend, children, skill, read, route, subprocess };
}

function selectSkill(id, check) {
  return async (payload, signal) => {
    assert.equal(payload.method, 'explore');
    const index = await readFile(join(payload.root, 'index.md'), 'utf8');
    assert.ok(index.includes(id));
    await check?.(payload, signal);
    return { content: JSON.stringify({ skills: [{ skill_id: id, reason: 'Matches the task.' }] }) };
  };
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

test('local settings and package checks reuse the reader without retaining credentials or previous field values', async t => {
  const f = await fixture(t);
  await f.read();
  const settings = _settings => f.backend({ action: 'settings', _settings });
  const first = await settings({ github_token: 'fixture-only-value', model: 'first-local-model' });
  assert.equal(first.fields.github_token.value, true);
  assert.equal(first.fields.model.value, 'first-local-model');
  assert.ok(!JSON.stringify(first).includes('fixture-only-value'));
  const checked = await f.backend({ action: 'check', path: join(f.sourcePath, 'reader-first') });
  assert.equal(checked.name, 'reader-first');
  assert.deepEqual(checked.files, ['SKILL.md']);
  await assert.rejects(settings({ base_url: 'invalid' }));
  const second = await settings({ model: 'second-local-model' });
  assert.equal(second.fields.github_token.value, false);
  assert.equal(second.fields.model.value, 'second-local-model');
  assert.equal(f.children.length, 1);
});

test('Node text preview validates uploads and counts Unicode characters across the clipping boundary', () => {
  const base64 = value => Buffer.from(value).toString('base64');
  const backend = () => assert.fail('Text preview should not start Python');
  assert.deepEqual(previewDocument({ name: 'chart.MD', data: base64('\uFEFF  中文\n') }, backend), { content: '中文', truncated: false });
  const capped = '𠮷'.repeat(50_000);
  assert.deepEqual(previewDocument({ name: 'chart.txt', data: base64(capped) }, backend), { content: capped, truncated: false });
  assert.deepEqual(previewDocument({ name: 'chart.txt', data: base64(capped + 'a') }, backend), { content: capped, truncated: true });
  assert.throws(() => previewDocument({ name: 'chart.txt', data: '!!!!' }, backend), /无法读取/);
  assert.throws(() => previewDocument({ name: 'chart.txt', data: base64([0xff]) }, backend), /UTF-8/);
  assert.throws(() => previewDocument({ name: 'chart.txt', data: base64('abc\0') }, backend), /二进制/);
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

test('warm DSH routing rereads sources, preserves per-request host callbacks, and clears invalid settings', async t => {
  const f = await fixture(t);
  const first = await f.route(selectSkill('reader-first', payload => assert.match(payload.prompt, /first query/)), { query: 'first query' });
  assert.deepEqual(first.skills.map(skill => skill.skill_id), ['reader-first']);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].workerArguments.at(-1), '--route-service');

  await assert.rejects(f.route(() => assert.fail('Invalid settings reached the model'), { settings: { json_mode: 'invalid' } }), /json.mode/i);
  await f.skill(f.sourcePath, 'reader-next', 'Changed source content.');
  await unlink(join(f.sourcePath, 'reader-first', 'SKILL.md'));
  const second = await f.route(selectSkill('reader-next', payload => assert.match(payload.prompt, /second query/)), { query: 'second query', model: 'different-model' });
  assert.deepEqual(second.skills.map(skill => skill.skill_id), ['reader-next']);
  assert.notDeepEqual(first.source_versions, second.source_versions);
  assert.equal(f.children.length, 1);
  await assert.rejects(f.route(() => ({ content: '{invalid selection}' })), /JSON/i);
  assert.deepEqual((await f.route(selectSkill('reader-next'))).skills.map(skill => skill.skill_id), ['reader-next']);
  assert.equal(f.children.length, 1);
});

test('warm vector routes use the current request credential without carrying it into later requests', async t => {
  const f = await fixture(t);
  const observed = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    observed.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', model: 'fixture-vector',
      data: body.input.map((_text, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
      usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const indexPath = join(f.root, 'index');
  const settings = { embedding_model: 'fixture-vector', embedding_base_url: `http://127.0.0.1:${server.address().port}/v1` };
  await f.backend({ action: 'analyze', sourcePath: f.sourcePath, indexPath, retrievalMode: 'vector',
    _host_model: { provider: 'fixture', model: 'fixture-model' }, _settings: { ...settings, embedding_api_key: 'fixture-build' },
  }, undefined, async () => ({ content: JSON.stringify({ capability: { text: 'Read data.', evidence: [{ line: 5 }] },
    when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] }) }));
  observed.length = 0;
  const vector = { mode: 'vector', indexPath };
  for (const key of ['fixture-first', 'fixture-second']) {
    assert.deepEqual((await f.route(selectSkill('reader-first'), { ...vector, settings: { ...settings, embedding_api_key: key } })).skills.map(skill => skill.skill_id), ['reader-first']);
    await assert.rejects(f.route(() => assert.fail('Missing credential reached the model'), { ...vector, settings }), /Missing embedding settings/);
  }
  assert.deepEqual(observed, ['Bearer fixture-first', 'Bearer fixture-second']);
  assert.equal(f.children.filter(child => child.workerArguments.at(-1) === '--route-service').length, 1);
});

test('overlapping routes use independent processes and the warm cancellation only stops its own bridge', async t => {
  const f = await fixture(t);
  const warmEntered = Promise.withResolvers();
  const coldEntered = Promise.withResolvers();
  const allowCold = Promise.withResolvers();
  const controller = new AbortController();
  let coldSignal;
  await f.skill(f.sourcePath, 'reader-parallel');
  const cancelled = assert.rejects(f.route(selectSkill('reader-first', (_payload, signal) => {
    warmEntered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }), { signal: controller.signal }), { name: 'AbortError' });
  await warmEntered.promise;
  const parallel = f.route(selectSkill('reader-parallel', async (_payload, signal) => {
    coldSignal = signal;
    coldEntered.resolve();
    await allowCold.promise;
  }));
  try {
    await coldEntered.promise;
    assert.equal(f.children.length, 2);
    assert.equal(f.children[0].workerArguments.at(-1), '--route-service');
    assert.match(f.children[1].workerArguments.at(-1), /worker\.py$/);
    controller.abort();
    await cancelled;
    assert.equal(coldSignal.aborted, false);
  } finally { allowCold.resolve(); }
  assert.deepEqual((await parallel).skills.map(skill => skill.skill_id), ['reader-parallel']);
  assert.deepEqual((await f.route(selectSkill('reader-first'))).skills.map(skill => skill.skill_id), ['reader-first']);
  assert.equal(f.children.length, 3);
});

test('exited warm route workers restart and backend disposal cancels both active routes', async t => {
  const f = await fixture(t);
  await f.route(selectSkill('reader-first'));
  const exited = new Promise(resolve => f.children[0].once('close', resolve));
  f.children[0].kill();
  await exited;
  await f.route(selectSkill('reader-first'));
  assert.equal(f.children.length, 2);

  const ready = [Promise.withResolvers(), Promise.withResolvers()];
  const run = i => assert.rejects(f.route(selectSkill('reader-first', (_payload, signal) => {
    ready[i].resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  })), /插件已停止/);
  const warm = run(0);
  await ready[0].promise;
  const cold = run(1);
  await ready[1].promise;
  await f.backend.dispose();
  await Promise.all([warm, cold]);
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(f.route(selectSkill('reader-first')), /插件已停止/);
});
