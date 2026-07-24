import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editSetText,
  modifyChangedText,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db undo/redo：按 docId 翻转草稿 entry', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const branch = await beginBranch(dbPath, docId);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText);

    const detail = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--json']));
    assert.equal(detail.stats.activeEntryCount, 1);
    assert.equal(detail.stats.undoDepth, 1);

    const undoResult = parseJsonStdout(await runBashDb(dbPath, ['undo', docId, '--json']));
    assert.equal(undoResult.ok, true);
    assert.equal(undoResult.branchId, branch.branchId);
    assert.equal(undoResult.undoDepth, 0);
    assert.equal(undoResult.redoDepth, 1);
    const afterUndo = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--json']));
    assert.equal(afterUndo.stats.activeEntryCount, 0);

    const redoResult = parseJsonStdout(await runBashDb(dbPath, ['redo', docId, '--json']));
    assert.equal(redoResult.ok, true);
    assert.equal(redoResult.undoDepth, 1);
    assert.equal(redoResult.redoDepth, 0);

    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', docId, '--yes', '--json']));
    assert.equal(discarded.ok, true);

    const undoNoTarget = await runBashDb(dbPath, ['undo'], { expectFailure: true });
    assert.match(undoNoTarget.stderr || undoNoTarget.stdout, /db undo requires <docId> or switch <docId>/);
  });
});

test('db switch 只接受一个 docId', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const selected = stdoutOf(await runBashDb(dbPath, ['switch', docId]));
    assert.equal(selected, `当前默认文档：${docId}`);

    const missing = await runBashDb(dbPath, ['switch'], { expectFailure: true });
    assert.match(missing.stderr || missing.stdout, /db switch requires <docId>/);
  });
});
