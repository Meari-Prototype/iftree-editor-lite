import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createConfiguredIftreeStore } from '../dist/src/backend/store-domain-adapter.js';
import { getProjectedDoc } from '../dist/src/backend/projection/doc-view.js';

// 草稿 entries 拆表（edit_branch_entries）：存储真相在子表、diff 列退役为元壳、
// 行出口拼合保持 diff JSON 契约。写侧 stage/undo/redo 从整包重写 O(K) 降为单行 O(1)。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-eb-entries-'));
  const store = createConfiguredIftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const entryTableCount = (store, branchId, status = null) => (status
  ? store.db.prepare('SELECT COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ? AND status = ?').get(branchId, status).n
  : store.db.prepare('SELECT COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ?').get(branchId).n);

function buildDocWithBranch(store) {
  const doc = store.createDoc({ title: 'EB', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const branch = store.beginEditBranch(doc.id);
  return { doc, a, branch };
}

test('stage 是 O(1) 追加：存储真相在子表，拼合出口带回全部 entries', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ docId: doc.id });
    const N = 200;
    for (let i = 0; i < N; i += 1) {
      branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: `第${i}版` } });
    }
    // 存储真相在子表（edit_branches 无 diff 列——这正是 O(K²) 的根治点）。
    assert.equal(entryTableCount(store, branch.id), N);
    // 拼合出口契约：branch.diff 里 entries 完整、有序、带 status/createdAt。
    const projected = JSON.parse(branch.diff);
    assert.equal(projected.entries.length, N);
    assert.equal(projected.entries[0].patch.node_note, '第0版');
    assert.equal(projected.entries[N - 1].patch.node_note, `第${N - 1}版`);
    assert.ok(projected.entries.every((e) => e.status === 'active' && e.createdAt));
    // getDoc 投影吃到最后一版。
    const view = getProjectedDoc(store, doc.id);
    const node = view.nodes.find((n) => String(n.id) === String(a.id));
    assert.equal(node.node_note, `第${N - 1}版`);
  });
});

test('undo/redo 单行翻转：LIFO 语义与 redo 复活最近撤销者', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ docId: doc.id });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '一' } });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '二' } });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '三' } });

    // undo×2：撤「三」再撤「二」。
    let result = store.undoEditBranchEntry({ docId: doc.id });
    assert.equal(result.undoDepth, 2);
    result = store.undoEditBranchEntry({ docId: doc.id });
    assert.equal(result.undoDepth, 1);
    assert.equal(result.redoDepth, 2);
    assert.equal(getProjectedDoc(store, doc.id).nodes.find((n) => String(n.id) === String(a.id)).node_note, '一');

    // 两次 undo 常落在同一毫秒（undoneAt 字符串相同，新旧实现都退化为按 seq 取）；
    // 手工拉开时间差还原真实操作节奏，验证 redo 的 LIFO——复活最近撤销的「二」。
    store.db.prepare(`
      UPDATE edit_branch_entries SET undone_at = '2099-01-01T00:00:00.000Z'
      WHERE branch_id = ? AND status = 'undone'
        AND json_extract(entry, '$.patch.node_note') = '二'
    `).run(branch.id);
    result = store.redoEditBranchEntry({ docId: doc.id });
    assert.equal(result.undoDepth, 2);
    assert.equal(getProjectedDoc(store, doc.id).nodes.find((n) => String(n.id) === String(a.id)).node_note, '二');

    // 新 stage 销毁 redo 分支（「三」永久丢弃）。
    branch = store.findEditBranch({ docId: doc.id });
    store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '四' } });
    assert.equal(entryTableCount(store, branch.id, 'undone'), 0, '追加后 redo 分支清空');
    const state = store.editBranchHistoryState(store.findEditBranch({ docId: doc.id }));
    assert.equal(state.undoDepth, 3);
    assert.equal(state.redoDepth, 0);
  });
});

test('保存/丢弃分支连带清子表（CASCADE）', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ docId: doc.id });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '改' } });
    assert.equal(entryTableCount(store, branch.id), 1);

    const committed = store.saveEditBranch({ docId: doc.id, summary: '保存' });
    assert.equal(committed.changed, true);
    assert.equal(entryTableCount(store, branch.id), 0, '分支行删除后子表级联清空');
    assert.equal(store.db.prepare('SELECT node_note FROM nodes WHERE id = ?').get(a.id).node_note, '改', '改动落主干');
  });
});

// ─── 编辑模式投影缓存（#3b：写代数戳失效）────────────────────────────────────

test('投影缓存：零写之间复用（引用相等），任何写后失效并反映新值', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    const branch = store.findEditBranch({ docId: doc.id });
    store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { node_note: '草稿版' } });

    // 首次 miss（投影并缓存），第二次命中——投影数组是同一引用（跳过了全量 SELECT 与 replay）。
    const first = getProjectedDoc(store, doc.id);
    const second = getProjectedDoc(store, doc.id);
    assert.equal(second.nodes, first.nodes, '零写之间第二次 getDoc 复用缓存投影');

    // 分支侧写（stage）失效缓存。
    store._appendEditBranchEntry(store.findEditBranch({ docId: doc.id }), {
      kind: 'node.update', node_id: a.id, patch: { node_note: '草稿版二' }
    });
    const afterStage = getProjectedDoc(store, doc.id);
    assert.notEqual(afterStage.nodes, first.nodes, 'stage 后缓存失效');
    assert.equal(afterStage.nodes.find((n) => String(n.id) === String(a.id)).node_note, '草稿版二');

    // base 侧直写（agent full 直写主干的形态）同样失效——投影输入变了。
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'base 新节点' });
    const afterBaseWrite = getProjectedDoc(store, doc.id);
    assert.ok(afterBaseWrite.nodes.some((n) => String(n.id) === String(b.id)), 'base 直写后投影含新节点');

    // 保存分支后读到主干；L3 视图负责丢弃已关闭分支的缓存。
    store.saveEditBranch({ docId: doc.id, summary: '保存' });
    assert.equal(getProjectedDoc(store, doc.id).nodes.find((n) => String(n.id) === String(a.id)).node_note, '草稿版二');
  });
});
