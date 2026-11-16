import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable } from '../src/backend.js';

function worker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), [fileURLToPath(new URL('../python/worker.py', import.meta.url))], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    child.on('error', reject);
    child.on('close', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

test('catalog browsing uses the official keyword API without a task or model, and service failure remains an error', async t => {
  const calls = [];
  let success = true;
  const record = { skill_name: 'fixture', skill_url: 'https://github.com/owner/repo/tree/main/fixture', repo_name: 'owner/repo', stars: 23 };
  const server = createServer((request, response) => {
    calls.push(new URL(request.url, 'http://localhost'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success, data: [record], meta: { page: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const input = { action: 'discover', page: 2, q: 'ignored', mode: 'vector', limit: 50, _settings: { skillnet_api_url: `http://127.0.0.1:${server.address().port}` } };
  const result = await worker(input);
  assert.equal(result.ok, true);
  assert.equal(result.data.browse, true);
  assert.equal(result.data.page, 2);
  assert.equal(result.data.limit, 12);
  assert.equal(result.data.skills[0].repo_name, 'owner/repo');
  assert.equal(calls[0].pathname, '/v1/search');
  assert.equal(calls[0].searchParams.get('q'), '');
  assert.equal(calls[0].searchParams.get('mode'), 'keyword');
  assert.equal(calls[0].searchParams.get('sort_by'), 'stars');
  assert.equal(calls[0].searchParams.get('page'), '2');
  success = false;
  assert.equal((await worker(input)).ok, false);
  const before = calls.length;
  assert.equal((await worker({ ...input, action: 'search', q: '' })).ok, false);
  assert.equal(calls.length, before);
});
