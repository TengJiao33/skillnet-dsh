import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeSkills } from '../src/native.js';

test('cold UI reads lease the default preset scope and dispose it even on errors', async () => {
  const key = {}; let disposed = 0;
  const ctx = {
    get: () => ({ acquireScope: async () => ({ key, [Symbol.asyncDispose]: async () => { disposed++; } }) }),
    skills: { get: async (name, options) => { assert.equal(options.scope, key); return { name }; }, snapshot: async options => { assert.equal(options.scope, key); throw new Error('provider error'); } },
  };
  const native = nativeSkills(ctx);
  assert.equal((await native.get('csv')).name, 'csv');
  await assert.rejects(native.snapshot({ cwd: '/project' }), /provider error/);
  assert.equal(disposed, 2);
});

test('model tool reads preserve the actual calling Agent scope', async () => {
  const agent = {}; let called = false;
  const registry = { snapshot: async options => { assert.equal(options.scope, agent); called = true; return { skills: [], complete: true }; } };
  const native = nativeSkills({ get: () => ({ serviceFor: who => { assert.equal(who, agent); return registry; } }), skills: {} });
  await native.snapshot({ scope: agent }); assert.equal(called, true);
});
