import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable } from '../src/backend.js';

test('GitHub downloads preserve complete pinned skills across rate limits and redirects', () => {
  const result = spawnSync(pythonExecutable(), [fileURLToPath(new URL('./github_download_test.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
