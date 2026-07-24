import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editSetText,
  modifyChangedText,
  runBashDb,
  stdoutOf,
  parseJsonStdout,
  withImportedFixture
} from './_helpers.mjs';

test('db draft 幂等，diff 只比较正文与草稿投影', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const first = await beginBranch(dbPath, docId);
    const second = parseJsonStdout(await runBashDb(dbPath, ['draft', docId, '--json']));
    assert.equal(second.ok, true);
    assert.equal(second.branch.id, first.branchId);
    assert.equal(second.branch.base_doc_id, docId);

    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText);
    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--json']));
    assert.equal(diff.kind, 'editBranch.diffView');
    assert.equal(diff.branch.id, first.branchId);
    assert.equal(diff.baseDoc.id, docId);
    assert.equal(diff.projectedDoc.id, docId);
    assert.equal(diff.stats.activeEntryCount, 1);
    assert.equal(diff.stats.undoDepth, 1);
    assert.ok(diff.rows.some((row) => row.status === 'modified'));
    assert.equal(diff.entries[0].field, 'node_note');
    assert.equal(diff.entries[0].old, '');
    assert.equal(diff.entries[0].new, modifyChangedText);
    assert.equal('mergeBase' in diff, false);

    const missingDoc = await runBashDb(dbPath, ['draft'], { expectFailure: true });
    assert.match(missingDoc.stderr || missingDoc.stdout, /db draft requires <docId>/);
  });
});

test('db commit 直接快进落库并关闭草稿', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    await beginBranch(dbPath, docId);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText);

    const committed = parseJsonStdout(await runBashDb(dbPath, ['commit', docId, '--summary', 'DBT_COMMIT', '--json']));
    assert.equal(committed.ok, true);
    assert.equal(committed.changed, true);
    assert.equal(committed.baseDocId, docId);
    const saved = parseJsonStdout(await runBashDb(dbPath, [
      'sql', 'SELECT node_note FROM nodes WHERE doc_id = ? AND address = ?',
      '--params', `'["${docId}","1-1-6-1-1"]'`, '--json'
    ]));
    assert.equal(saved.rows[0].node_note, modifyChangedText);

    const noDraft = await runBashDb(dbPath, ['diff', docId], { expectFailure: true });
    assert.match(noDraft.stderr || noDraft.stdout, /Edit branch not found/);
  });
});

test('db discard 预览不落库，--yes 弃稿且正文不变', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    await beginBranch(dbPath, docId);
    await editSetText(dbPath, docId, '1-1-3-2-1', 'DBT_DRAFT_DISCARD_SHOULD_NOT_APPLY');

    const preview = stdoutOf(await runBashDb(dbPath, ['discard', docId]));
    assert.match(preview, new RegExp(`discard 预览：将丢弃草稿 doc:${docId}`));
    const stillThere = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--json']));
    assert.equal(stillThere.stats.activeEntryCount, 1);

    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', docId, '--yes', '--json']));
    assert.equal(discarded.ok, true);
    assert.equal(discarded.changed, true);
    const saved = parseJsonStdout(await runBashDb(dbPath, [
      'sql', 'SELECT node_note FROM nodes WHERE doc_id = ? AND address = ?',
      '--params', `'["${docId}","1-1-3-2-1"]'`, '--json'
    ]));
    assert.equal(saved.rows[0].node_note, '');
  });
});
