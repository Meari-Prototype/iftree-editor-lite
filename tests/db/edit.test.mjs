import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  parseJsonStdout,
  runBashDb,
  withImportedFixture
} from './_helpers.mjs';

test('db edit 只暂存节点备注和类型', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const branch = await beginBranch(dbPath, docId);

    const noteResult = parseJsonStdout(await runBashDb(dbPath, [
      'edit', docId, '1-1-6-1-1', '--set', 'node_note', 'DBT_EDIT_NOTE', '--doc-id', docId, '--json'
    ]));
    assert.equal(noteResult.action, 'node.update');
    assert.equal(noteResult.editBranch.id, branch.branchId);
    assert.equal(noteResult.editBranch.base_doc_id, docId);
    assert.equal('owner' in noteResult.editBranch, false);

    const typeResult = parseJsonStdout(await runBashDb(dbPath, [
      'edit', docId, '1-1-6-1-1', '--set', 'node_type', '如果', '--doc-id', docId, '--json'
    ]));
    assert.equal(typeResult.node.node_type, 'IF');

    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--json']));
    assert.equal(diff.stats.activeEntryCount, 2);
    assert.deepEqual(diff.entries.map((entry) => entry.field).sort(), ['node_note', 'node_type']);

    for (const field of ['text', 'trust_level', 'node_title']) {
      const blocked = await runBashDb(dbPath, [
        'edit', docId, '1-1-6-1-1', '--set', field, 'blocked', '--doc-id', docId
      ], { expectFailure: true });
      assert.match(blocked.stderr || blocked.stdout, /unsupported field/);
    }
    for (const args of [
      ['--insert', 'child', 'blocked'],
      ['--delete'],
      ['--move', '1-1-6-1-2']
    ]) {
      const blocked = await runBashDb(dbPath, ['edit', docId, '1-1-6-1-1', ...args, '--doc-id', docId], { expectFailure: true });
      assert.notEqual(blocked.exitCode, 0);
    }
  });
});

test('db edit 需要先 draft', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const noDraft = await runBashDb(dbPath, [
      'edit', docId, '1-1-6-1-1', '--set', 'node_note', 'NO_DRAFT', '--doc-id', docId
    ], { expectFailure: true });
    assert.match(noDraft.stderr || noDraft.stdout, /请先 draft/);
  });
});
