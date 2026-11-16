import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from '../src/task-store.js';

test('task history isolates corruption, migrates large legacy results, and paginates summaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillnet-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tasks'));
  const id = 'skillnet-create-0123456789abcdef';
  await writeFile(join(root, 'tasks', id + '.json'), JSON.stringify({ id, status: 'completed', action: 'create', startedAt: '2026-11-11T00:00:00Z', result: { source: 'x'.repeat(1024 * 1024) } }));
  await writeFile(join(root, 'tasks', 'skillnet-route-bad.json'), '{corrupt');
  const store = createTaskStore(root);
  const page = await store.list({ limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.damaged, 1);
  assert.equal(Object.hasOwn(page.items[0], 'result'), false);
  assert.ok((await readFile(join(root, 'tasks', id + '.json'), 'utf8')).length < 1024);
  assert.equal((await store.get(id)).result.source.length, 1024 * 1024);
  await store.write({ id: 'skillnet-route-1123456789abcdef', action: 'route', status: 'completed', startedAt: '2026-11-12T00:00:00Z', result: { skills: [] } });
  assert.equal((await store.list({ limit: 1 })).hasMore, true);
  assert.equal((await store.list({ limit: 1, offset: 1 })).items[0].id, id);
  await writeFile(join(root, 'results', id + '.json'), 'broken');
  assert.match((await store.get(id)).resultError, /无法读取/);
  assert.equal((await store.list()).items.length, 2);
});
