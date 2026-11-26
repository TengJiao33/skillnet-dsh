import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../client/chatDraft.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
const { openSkillDraft, openAnalysisDraft, openRouteDraft } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const selection = { sessionId: 'chosen-conversation', reference: '/principles ', skill: { name: 'principles', path: 'C:/skills/principles/SKILL.md' } };

test('using a skill appends through the native draft API before navigation, without replacing or sending', () => {
  const calls = [], binding = { sessionId: selection.sessionId };
  const ctx = {
    sessions: { retain(id, options) { assert.equal(id, selection.sessionId); assert.equal(options.source, 'skillnet-draft'); return { binding, release() { calls.push('release'); } }; } },
    conversation: { input: { requestDraftInitialization(target, options) { assert.equal(target, binding); assert.deepEqual(options, { prompt: '/principles ', whenDraftExists: 'append' }); calls.push('append'); return 'applied'; } } },
    uiWorkspace: { openSession(id) { assert.equal(id, selection.sessionId); calls.push('open'); } },
  };
  openSkillDraft(ctx, selection);
  assert.deepEqual(calls, ['append', 'open', 'release']);
});

test('a locked draft is left untouched and navigation is not claimed as successful', () => {
  let released = 0;
  const ctx = {
    sessions: { retain: () => ({ binding: {}, release: () => { released++; } }) },
    conversation: { input: { requestDraftInitialization: () => 'blocked' } },
    uiWorkspace: { openSession() { throw new Error('Blocked insertion must not navigate.'); } },
  };
  assert.throws(() => openSkillDraft(ctx, selection), /正在提交消息/);
  assert.equal(released, 1);
});

test('analysis opens a native editable draft without followup or model execution', () => {
  const calls = [];
  openAnalysisDraft({
    sessions: { retain: id => ({ binding: { id }, release: () => calls.push('release') }) },
    conversation: { input: { requestDraftInitialization(binding, options) {
      assert.equal(binding.id, 'new-graph-session');
      assert.deepEqual(options, { prompt: '请分步建图', whenDraftExists: 'append' });
      calls.push('draft'); return 'applied';
    } } },
    uiWorkspace: { openSession: id => calls.push(id) },
  }, { sessionId: 'new-graph-session', prompt: '请分步建图' });
  assert.deepEqual(calls, ['draft', 'new-graph-session', 'release']);
});

test('matching adds the prepared task to the chosen editable draft without sending', () => {
  const calls = [];
  const route = { sessionId: 'chosen-conversation', prompt: '按推荐技能检查表格' };
  openRouteDraft({
    sessions: { retain(id, options) {
      assert.deepEqual([id, options.source], [route.sessionId, 'skillnet-route-draft']);
      return { binding: { id }, release: () => calls.push('release') };
    } },
    conversation: { input: { requestDraftInitialization(binding, options) {
      assert.equal(binding.id, route.sessionId);
      assert.deepEqual(options, { prompt: route.prompt, whenDraftExists: 'append' });
      calls.push('draft'); return 'applied';
    } } },
    uiWorkspace: { openSession: id => calls.push(id) },
  }, route);
  assert.deepEqual(calls, ['draft', route.sessionId, 'release']);
});
