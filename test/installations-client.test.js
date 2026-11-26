import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../client/installationManagement.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'shared-react', setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { installationAt, installationsFrom, installationLocation, RemoveInstalledSkill, InstallationManagementDialog } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const source = 'https://github.com/example/skills/tree/main/report';
const personal = { id: 'personal', name: 'report', scope: 'user', state: 'installed', exists: true, url: source, path: 'C:\\DSH\\skills\\report' };
const reports = { id: 'reports', name: 'report', scope: 'managed', state: 'installed', exists: true, url: source, path: 'D:/libraries/Reports/skills/report' };
const removed = { ...personal, id: 'removed', state: 'removed', path: 'D:/libraries/Old/skills/report' };
const connections = [{ id: 'reports-lib', name: '报表分析', sourcePath: 'd:\\Libraries\\Reports\\skills\\' }];

test('catalog locations require exact source URLs and active packages and retain distinct library copies', () => {
  const rows = [
    personal, reports, removed,
    { ...reports, id: 'missing', path: 'D:/libraries/Gone/skills/report', exists: false },
    { ...reports, id: 'other-source', path: 'D:/libraries/Other/skills/report', url: source + '-other' },
    { ...reports, id: 'unknown-source', path: 'D:/libraries/Unknown/skills/report', url: null },
  ];
  const found = installationsFrom(rows, source);
  assert.deepEqual(found, [personal, reports]);
  assert.deepEqual(found.map(record => installationLocation(record, connections)), ['DSH 个人技能库', '报表分析']);
  assert.deepEqual(installationsFrom(rows, ''), []);
});

test('uninstall selects a unique managed record by actual package path', () => {
  const rows = [personal, reports, removed];
  assert.equal(installationAt(rows, 'd:\\Libraries\\REPORTS\\skills\\report\\SKILL.md'), reports);
  assert.equal(installationAt(rows, 'D:/libraries/not-tracked/skills/report/SKILL.md'), undefined);
  assert.equal(installationAt(rows, 'D:/libraries/Old/skills/report/SKILL.md'), undefined);
  assert.equal(installationAt([...rows, { ...reports, id: 'duplicate' }], 'D:/libraries/Reports/skills/report/SKILL.md'), undefined);
  const linux = { ...reports, path: '/srv/skills/Report' };
  assert.equal(installationAt([linux], '/srv/skills/report/SKILL.md'), undefined);
  assert.equal(installationAt([linux], '/srv/skills/Report/SKILL.md'), linux);
});

test('management renders an uninstall confirmation and keeps restore in the removed list', () => {
  const state = { inventory: { records: [personal, reports, removed], libraries: connections }, loading: false, busy: false };
  const action = filePath => renderToStaticMarkup(createElement(RemoveInstalledSkill, { management: state, filePath }));
  assert.match(action(reports.path + '/SKILL.md'), /卸载/);
  assert.equal(action('D:/libraries/Manual/skills/report/SKILL.md'), '');
  const render = dialog => renderToStaticMarkup(createElement(InstallationManagementDialog, { management: { ...state, dialog } }));
  const confirmation = render({ kind: 'remove', record: reports });
  assert.match(confirmation, /确认卸载/);
  assert.match(confirmation, /可在「已移除技能」中恢复/);
  assert.ok(confirmation.includes(reports.path));
  const recovery = render({ kind: 'removed' });
  assert.ok(recovery.includes(removed.path));
  assert.match(recovery, />恢复<\/button>/);
  assert.ok(!recovery.includes(reports.path));
});
