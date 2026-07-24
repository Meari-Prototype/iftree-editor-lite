import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBranchEntryCounts, formatBranchLine } from '../../dist/src/backend/text/branch-status.js';

// 纯函数（不碰 DB）；但本项目统一用 electron 跑测试、禁用 node（见 ../_assert-electron.mjs）。问题 3：changes/branch list 此前只数笼统 active/undone，
// 现按保留的 op-log kind 分类，并标当前 switch 分支。

const branchWith = (entries, extra = {}) => ({
  id: 7,
  base_doc_id: 'doc-x',
  diff: JSON.stringify({ entries }),
  updated_at: '2026-06-15',
  ...extra
});

test('parseBranchEntryCounts：按 kind 分类，撤销单列、不计入 active', () => {
  const counts = parseBranchEntryCounts(branchWith([
    { kind: 'node.update' }, { kind: 'node.update' },
    { kind: 'ref.add' },
    { kind: 'entity.create' },
    { kind: 'ref.delete', status: 'undone' }
  ]));
  assert.equal(counts.update, 2);
  assert.equal(counts.insert, 0);
  assert.equal(counts.delete, 0);
  assert.equal(counts.move, 0);
  assert.equal(counts.other, 2);
  assert.equal(counts.undone, 1);
  assert.equal(counts.active, 4); // 全部非 undone
});

test('formatBranchLine：改常驻，其他/撤销有才显示', () => {
  const line = formatBranchLine(branchWith([{ kind: 'node.update' }, { kind: 'ref.add' }]));
  assert.match(line, /branch:7/);
  assert.match(line, /改:1/);
  assert.match(line, /增:0/);
  assert.match(line, /删:0/);
  assert.doesNotMatch(line, /移:/);
  assert.doesNotMatch(line, /撤销:/);

  const withOther = formatBranchLine(branchWith([{ kind: 'entity.create' }, { kind: 'ref.delete', status: 'undone' }]));
  assert.match(withOther, /其他:1/);
  assert.match(withOther, /撤销:1/);
});

test('formatBranchLine：current 标记当前 switch 分支', () => {
  const b = branchWith([{ kind: 'node.update' }]);
  assert.match(formatBranchLine(b, { current: 7 }), /^\* branch:7/);
  assert.doesNotMatch(formatBranchLine(b, { current: 9 }), /^\*/);
  assert.doesNotMatch(formatBranchLine(b), /^\*/);
});

test('空 / 坏 diff 不抛错', () => {
  assert.equal(parseBranchEntryCounts({}).active, 0);
  assert.equal(parseBranchEntryCounts({ diff: 'not json' }).active, 0);
  assert.match(formatBranchLine({ id: 1, base_doc_id: 'd' }), /改:0\t增:0\t删:0/);
});
