import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createConfiguredIftreeStore } from '../dist/src/backend/store-domain-adapter.js';
import { stageEntityWrite } from '../dist/src/backend/entities/write.js';
import { entityStateForRead } from '../dist/src/backend/entities/projection.js';

// 回归：投影态 entity.create 命中 base 已有实体（同 doc + 同 normalized_literal）时，
// 后续 entity.bindNode 用 tmp_id 引用必须能在草稿预览里解析到该实体。
//
// 曾经的 bug：投影版 applyEntityEntry 命中 existing 分支只更新 literal、不登记
// tmp_id → 真实 id 别名；后续 bindNode 的 entityByRef(tmp_id) 找不到该 tmp_id →
// 静默跳过，草稿预览看不到 binding。但落库版 entityIdByTmp 会建立映射，定稿后
// binding 真实写入——投影与落库行为分歧（草稿预览无绑定，定稿后凭空出现）。
//
// 本测试经真实 stage 入口构造：先在主库建一个实体，再在编辑分支里 entity.create
// 同 literal 的实体（命中 existing），随后 entity.bindNode 用 tmp_id 绑定，断言
// 投影态 entityStateForRead 能看到该绑定。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-entity-projection-'));
  const store = createConfiguredIftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('entity.create 命中已有实体后 bindNode：草稿预览经 tmp 别名可见绑定（回归投影/落库分歧）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'EntityProjection', rootText: '根' });
    const node = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '正文节点' });

    // 主库已有实体「示例术语」（与分支 entity.create 的 literal 相同 → 命中 existing 分支）。
    store.db.prepare('INSERT INTO entities (id, doc_id, literal, normalized_literal) VALUES (?, ?, ?, ?)')
      .run('ent-existing', doc.id, '示例术语', '示例术语');

    const branch = store.beginEditBranch(doc.id, 'human');
    // entity.create 同 literal：投影命中 existing，不新增实体行，但登记 tmp 别名。
    const staged = stageEntityWrite(store, branch, { docId: doc.id, literal: '示例术语' }, 'entity.create');
    assert.equal(staged.ok, true, 'stage entity.create 成功');
    const tmpId = staged.editBranch && JSON.parse(staged.editBranch.diff || '{}').entries
      ?.find((entry) => entry.kind === 'entity.create')?.tmp_id;
    assert.ok(tmpId, 'entity.create 应生成 tmp_id');

    // bindNode 用 tmp_id 引用：修复前 entityByRef(tmp_id) 找不到 → 绑定静默丢失。
    const afterCreate = store.findEditBranch({ docId: doc.id });
    const bound = stageEntityWrite(store, afterCreate, { entityId: tmpId, nodeId: node.id }, 'entity.bindNode');
    assert.equal(bound.ok, true, 'stage entity.bindNode 成功');

    // 草稿预览：投影态必须能看到这条 binding（修复前为 0）。
    const currentBranch = store.findEditBranch({ docId: doc.id });
    const projected = entityStateForRead(store, currentBranch);
    const binding = projected.bindings.find((row) => String(row.node_id) === String(node.id));
    assert.ok(binding, '草稿预览应看到 tmp_id 实体的 node 绑定（命中 existing 分支的别名解析）');
    assert.equal(String(binding.entity_id), 'ent-existing', '绑定应落在真实实体 id 上');
  });
});
