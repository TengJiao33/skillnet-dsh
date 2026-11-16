import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';

let revision = 0;
async function client(t) {
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../client/upstream/src/useWorkspace.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'shared-react', setup(b) { b.onResolve({ filter: /^react$/ }, () => ({ path: react, external: true })); } }],
    footer: { js: 'export { refreshLibrary as refreshLibraryForTest };' },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text + `\n// ${revision++}`).toString('base64'));
}
const library = { id: 'fixture-library', name: 'Fixture', sourcePath: 'C:/fixture/skills', indexPath: 'C:/fixture/skills/.skillnet' };
const data = description => ({ connection: library, name: 'Fixture', source: { kind: 'source', title: 'Fixture', skills: [{ id: 'fixture-skill', name: 'fixture-skill', description, source: 'Read supplied data.', path: 'C:/fixture/skills/fixture-skill/SKILL.md' }], relations: [] }, graph: null, analysisError: null, warnings: [], changedSkills: 0, addedSkills: 0, removedSkills: 0 });
const response = value => new Response(JSON.stringify({ ok: true, data: value }), { headers: { 'content-type': 'application/json' } });

test('preloading is shared and a returning panel renders existing skills before another request completes', async t => {
  const module = await client(t);
  let release, reads = 0;
  const ready = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    const action = String(url).split('/').at(-1);
    if (action === 'libraries') return response([library]);
    if (action === 'workspace-config') return response({ sourcePath: library.sourcePath });
    assert.equal(action, 'workspace-read'); reads++;
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'indexPath'), false);
    await ready;
    return response(data('Current source.'));
  };
  const a = module.preloadWorkspace();
  const b = module.preloadWorkspace();
  assert.equal(a, b);
  release();
  await a;
  assert.equal(reads, 1);
  globalThis.fetch = async () => { throw new Error('Rendering a remembered view must not wait for a fetch.'); };
  function Panel() {
    const workspace = module.useWorkspace();
    return createElement('div', { 'data-restoring': String(workspace.restoring) }, workspace.dataset.skills.map(skill => skill.name).join(','));
  }
  const first = renderToString(createElement(Panel));
  const returned = renderToString(createElement(Panel));
  assert.equal(first, returned);
  assert.match(returned, /data-restoring="false"/);
  assert.match(returned, /fixture-skill/);
});

test('background refresh shares an in-flight read but reads updated files again after it finishes', async t => {
  const module = await client(t);
  let reads = 0;
  globalThis.fetch = async () => response(data(`Revision ${++reads}.`));
  const a = module.refreshLibraryForTest(library);
  const b = module.refreshLibraryForTest(library);
  assert.equal(a, b);
  assert.equal((await a).source.skills[0].description, 'Revision 1.');
  const next = await module.refreshLibraryForTest(library);
  assert.equal(next.source.skills[0].description, 'Revision 2.');
});

test('failed startup can retry without leaving the panel stuck on a rejected preload', async t => {
  const module = await client(t);
  let failed = true;
  globalThis.fetch = async url => {
    const action = String(url).split('/').at(-1);
    if (action === 'libraries') return response([library]);
    if (action === 'workspace-config') return response({ sourcePath: library.sourcePath });
    if (failed) throw new Error('Read interrupted');
    return response(data('Recovered.'));
  };
  await assert.rejects(module.preloadWorkspace(), /Read interrupted/);
  failed = false;
  assert.equal((await module.preloadWorkspace()).dataset.skills[0].description, 'Recovered.');
});

test('old source and analysis preferences open one current library with the saved profile', async t => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  let saved;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify(saved), setItem() {} } });
  t.after(() => { if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage; });
  for (const scenario of [
    { view: null },
    { view: { sourceId: 'local-source', analysisRevision: 'snapshot-1' } },
    { view: { sourceId: 'local-source' } },
    { view: { sourceId: 'local-source', analysisRevision: 'snapshot-2' } },
    { view: { sourceId: 'local-analysis', analysisRevision: 'snapshot-2' } },
  ]) {
    globalThis.fetch = originalFetch;
    const module = await client(t);
    saved = scenario.view ? { collection: 'local:' + library.id, selectedSkillId: 'fixture-skill', ...scenario.view } : null;
    const value = data('Current source.');
    value.analysisRevision = 'snapshot-2';
    value.graph = {
      schema_version: 1, embedding_model: '', embedding_base_url: '', relations: [],
      skills: [{ skill_id: 'fixture-skill', name: 'fixture-skill', source: value.source.skills[0].source, path: value.source.skills[0].path, content_hash: 'fixture',
        profile: { capability: { text: 'Analyzed capability.', evidence: [{ line: 1 }] }, when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] } }],
    };
    globalThis.fetch = async url => {
      const action = String(url).split('/').at(-1);
      if (action === 'libraries') return response([library]);
      if (action === 'workspace-config') return response({ sourcePath: library.sourcePath });
      assert.equal(action, 'workspace-read');
      return response(value);
    };
    const state = await module.preloadWorkspace();
    assert.equal(state.sourceId, 'local-library');
    assert.equal(state.dataset.kind, 'source');
    assert.equal(state.dataset.skills[0].description, 'Current source.');
    assert.equal(state.dataset.skills[0].profile.capability.text, 'Analyzed capability.');
    assert.equal(state.localData.analysisRevision, 'snapshot-2');
  }
});

test('adding a skill keeps the saved analysis and evidence, and exposes the new source without an invented profile', async t => {
  const module = await client(t);
  const value = data('Current source.');
  const original = value.source.skills[0];
  const second = { ...original, id: 'second-skill', name: 'second-skill', source: 'Second skill.' };
  const pending = { ...original, id: 'new-skill', name: 'new-skill', source: 'New skill.' };
  const analyzed = skill => ({ skill_id: skill.id, name: skill.name, path: skill.path, source: skill.source, content_hash: 'fixture',
    profile: { capability: { text: skill.name, evidence: [{ line: 1 }] }, when_to_use: [], scenarios: [], inputs: [], outputs: [], constraints: [], tools: [] } });
  value.graph = { schema_version: 1, embedding_model: '', embedding_base_url: '', skills: [analyzed(original), analyzed(second)],
    relations: [{ source: original.id, target: second.id, type: 'similar_to', contexts: [{ scenario: 'Original scenario', explanation: 'Original evidence', conditions: [], source_evidence: [{ line: 1 }], target_evidence: [{ line: 1 }] }] }] };
  value.source.skills = [{ ...original, source: 'Changed source.\n' + original.source }, second, pending];
  value.addedSkills = 1; value.changedSkills = 1; value.analysisRevision = 'original-snapshot';
  globalThis.fetch = async url => {
    const action = String(url).split('/').at(-1);
    if (action === 'libraries') return response([library]);
    if (action === 'workspace-config') return response({ sourcePath: library.sourcePath });
    assert.equal(action, 'workspace-read');
    return response(value);
  };
  const state = await module.preloadWorkspace();
  assert.equal(state.sourceId, 'local-library');
  assert.equal(state.dataset.skills.length, 3);
  assert.equal(state.localData.analysis.skills.length, 2);
  assert.equal(state.localData.analysis.relations.length, 1);
  assert.equal(state.localData.analysis.skills.find(skill => skill.id === original.id).source, original.source);
  assert.equal(state.dataset.skills.find(skill => skill.id === original.id).source, 'Changed source.\n' + original.source);
  assert.equal(state.dataset.skills.find(skill => skill.id === original.id).profile.capability.text, original.name);
  assert.equal(state.dataset.skills.find(skill => skill.id === pending.id).source, pending.source);
  assert.equal(state.dataset.skills.find(skill => skill.id === pending.id).profile, undefined);
  assert.equal(state.localData.addedSkills, 1);
  assert.equal(state.localData.analysisRevision, 'original-snapshot');
});
