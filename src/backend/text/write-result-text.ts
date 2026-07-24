// MCP 写动词/状态返回的紧凑文本渲染（projectneed 15-5-1-3：ASCII 非裸 JSON，--json 才裸传）。
// 纯渲染、不改逻辑：吃后端原始返回，挑结果要点成几行人类可读文本，省 token。
// 形态按数据走——状态摘要用键值行、节点树用缩进地址、列表用每项一行，不强求 ASCII tree。
// diff 预览另有 diff-text；此处管「写动作落库结果」与少数列表/行返回。

import { parseBranchEntryCounts } from './branch-status.js';
import { clip, cell, clipRows } from './text-budget.js';
import type { WriteResult } from './write-result.js';

// 通用写返回：commit/edit/draft/undo/redo/discard/vectors/certify/revert/switch。
// 挑结果要点，丢快照大字符串。
/**
 * @param {unknown} res
 * @param {{ label?: string }} [opts]
 */
export function formatWriteResult(res: WriteResult | null | undefined, { label }: { label?: string } = {}) {
  if (res == null) return '(空)';
  if (typeof res !== 'object') return String(res);
  if (res.ok === false || res.error) {
    const msg = res.error || res.message || '';
    return `${label || res.action || '失败'}  失败${msg ? '：' + clip(msg, 200) : ''}`;
  }
  const lines: string[] = [];
  const head: string[] = [label || res.action || 'result'];
  if (res.changed === false) head.push('未改动');
  if (res.docId) head.push(`doc:${res.docId}`);
  if (res.branchId != null) head.push(`branch:${res.branchId}`);
  if (res.baseDocId && res.baseDocId !== res.docId) head.push(`base:${res.baseDocId}`);
  if (res.commitId) head.push(`commit:${res.commitId}`);
  if (res.revertCommitId) head.push(`revert→:${res.revertCommitId}`);
  lines.push(head.join('  '));

  const n = res.node;
  if (n && typeof n === 'object') {
    const tags: string[] = [];
    if (n.address) tags.push(n.address);
    if (n.node_type) tags.push(n.node_type);
    if (n.trust_level) tags.push(`trust:${n.trust_level}`);
    if (n.pending_insert) tags.push('pending');
    let line = `  node ${tags.join(' ')}`.replace(/\s+$/, '');
    if (n.text) line += `  「${clip(n.text)}」`;
    lines.push(line);
    const meta: string[] = [];
    if (n.node_note) meta.push(`note:「${clip(n.node_note, 40)}」`);
    if (meta.length) lines.push(`       ${meta.join('  ')}`);
  }
  if (res.insertedNodeId != null) lines.push(`  inserted:${res.insertedNodeId}`);

  const actionFacts: string[] = [];
  if (res.nodeId != null) actionFacts.push(`nodeId=${res.nodeId}`);
  if (res.sourceNodeId != null) actionFacts.push(`sourceNodeId=${res.sourceNodeId}`);
  if (res.targetNodeId != null) actionFacts.push(`targetNodeId=${res.targetNodeId}`);
  if (res.newParentId != null) actionFacts.push(`newParentId=${res.newParentId}`);
  if (res.refId != null) actionFacts.push(`refId=${res.refId}`);
  if (res.entityId != null) actionFacts.push(`entityId=${res.entityId}`);
  if (Array.isArray(res.entityIds) && res.entityIds.length) actionFacts.push(`entityIds=${res.entityIds.join(',')}`);
  if (res.kind) actionFacts.push(`kind=${res.kind}`);
  if (res.status) actionFacts.push(`status=${res.status}`);
  if (res.direction) actionFacts.push(`direction=${res.direction}`);
  if (actionFacts.length) lines.push(`  ${actionFacts.join('  ')}`);

  // node.split：交代拆分规模——分支行的逐动作计数对 split 恒 +1，不反映实际拆出的节点数。
  if (res.splitNewNodeCount != null) {
    lines.push(res.splitParagraphCount != null
      ? `  按原文段落拆分：${res.splitParagraphCount} 段、共 ${res.splitNewNodeCount} 句下沉为子节点`
      : `  切成 ${res.splitSentenceCount ?? '?'} 句：首句留守原节点，${res.splitNewNodeCount} 句下沉为子节点`);
  }

  // 新增 ref/entity 回执带草稿内临时句柄，供同草稿后续操作引用。
  const ent = res.entity;
  if (ent && typeof ent === 'object' && ent.id != null) {
    lines.push(`  entity:${ent.id}${ent.literal ? `  「${clip(ent.literal, 40)}」` : ''}（bindNode 传 entityId=${ent.id}）`);
  }
  const lk = res.link;
  if (lk && typeof lk === 'object') {
    const ids = [lk.entity_a_id, lk.entity_b_id].filter((value) => value != null).join('↔');
    lines.push(`  link:${ids}${lk.kind ? `  [${lk.kind}]` : ''}`);
  }
  const rf = res.ref;
  if (rf && typeof rf === 'object' && rf.id != null) {
    const rk = rf.ref_kind || rf.kind;
    lines.push(`  ref:${rf.id}${rk ? `  [${rk}]` : ''}（ref.delete 传 refId=${rf.id}）`);
  }
  if (res.insertedRefId != null) lines.push(`  ref:${res.insertedRefId}（ref.delete 传 refId=${res.insertedRefId}）`);

  const branch = res.editBranch || res.branch;
  if (branch && typeof branch === 'object' && branch.id != null) {
    let counts;
    if (branch.counts && typeof branch.counts === 'object') {
      const c = branch.counts;
      const other = c.其他 ?? c.other ?? 0;
      counts = `改${c.改 ?? c.update ?? 0} 增${c.增 ?? c.insert ?? 0} 删${c.删 ?? c.delete ?? 0} 移${c.移 ?? c.move ?? 0}${other ? ` 其他${other}` : ''} 撤${c.撤销 ?? c.undone ?? 0}`;
    } else {
      const c = parseBranchEntryCounts(branch);
      counts = `改${c.update} 增${c.insert} 删${c.delete} 移${c.move}${c.other ? ` 其他${c.other}` : ''} 撤${c.undone}`;
    }
    lines.push(`  branch:${branch.id}  ${counts}`);
  }
  if (res.undoDepth != null || res.redoDepth != null) {
    lines.push(`  undo:${res.undoDepth ?? 0} redo:${res.redoDepth ?? 0}`);
  }

  const h = res.history;
  if (h && typeof h === 'object' && (h.commit_id || h.id)) {
    lines.push(`  commit:${h.commit_id || h.id}  「${clip(h.summary, 60)}」${h.saved_at ? '  @' + h.saved_at : ''}`);
  }
  if (res.pragmas && typeof res.pragmas === 'object') {
    lines.push(`  ${Object.entries(res.pragmas).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (res.restoredPragmas && typeof res.restoredPragmas === 'object') {
    lines.push(`  restored ${Object.entries(res.restoredPragmas).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (res.checkpoint) lines.push(`  checkpoint:${res.checkpoint}`);
  // relink：只显示重绑后的新路径，绝不把后端附带的全库 docs 刷新列表 dump 出来（曾撑爆 token）。
  if (res.source && typeof res.source === 'object' && res.source.original_path) {
    lines.push(`  source:${res.source.original_path}`);
  }
  // relink 的目标自检（handler 附带的 relink.targetCheck sideEffect）：只提示、不阻断——
  // relink 本就不替外部程序管文件状态，但绑到不存在的路径必须让调用方看见。
  const targetCheck = Array.isArray(res.sideEffects)
    ? res.sideEffects.find((fx) => fx && typeof fx === 'object' && fx.effect === 'relink.targetCheck')
    : null;
  if (targetCheck) {
    const exists = targetCheck.targetExists === true;
    lines.push(`  targetExists:${exists}${exists ? '' : '（目标文件当前不存在——relink 只改登记不校验，请确认路径无误）'}`);
  }
  if (Array.isArray(res.touchedNodeIds) && res.touchedNodeIds.length) {
    const ids = res.touchedNodeIds.slice(0, 5).join(' ');
    lines.push(`  touched:${res.touchedNodeIds.length}节点 ${ids}${res.touchedNodeIds.length > 5 ? ' …' : ''}`);
  }
  if (Array.isArray(res.touchedDocIds) && res.touchedDocIds.length) {
    const ids = res.touchedDocIds.slice(0, 5).join(' ');
    lines.push(`  touched:${res.touchedDocIds.length}文档 ${ids}${res.touchedDocIds.length > 5 ? ' …' : ''}`);
  }
  const hist = res.doc && Array.isArray(res.doc.history) ? res.doc.history : null;
  if (hist && hist.length) {
    lines.push(`  历史 ${hist.length} 条：`);
    for (const c of hist.slice(0, 4)) {
      lines.push(`    ${c.commit_id || c.id}  「${clip(c.summary, 40)}」`);
    }
    if (hist.length > 4) lines.push(`    … 余 ${hist.length - 4} 条`);
  }

  return lines.join('\n');
}

// import：导入路径 + 文档标识 + 节点数 + 向量提示（embed 与否两种口径）。
export function formatImportResult(res: WriteResult | null | undefined, { relativePath, embed }: { relativePath?: string; embed?: boolean } = {}) {
  if (!res || res.ok !== true) return `导入失败：${JSON.stringify(res)}`;
  const lines = [
    `已导入 ${res.relativePath || relativePath || ''}`,
    `doc:${res.docId} ${res.title || ''}`,
    `节点数：${res.nodeCount || 0}`
  ];
  if (embed === true) lines.push(res.vectorWarning ? `向量：同步建立失败（${res.vectorWarning}）` : '向量：已同步建立');
  else lines.push('向量：未建（默认后补；需即时可检索传 embed:true，或用 vectors 动词）');
  return lines.join('\n');
}

// vectors：覆盖率 + 增量账目（新增/重嵌/清孤儿/保留）。
export function formatVectorsResult(res: WriteResult | null | undefined, { docId }: { docId?: string | number } = {}) {
  if (!res || res.ok === false) return formatWriteResult(res, { label: 'vectors' });
  if (res.skipped) return `vectors  doc:${res.docId || docId}  跳过（${res.reason || '向量未启用'}）`;
  const after = Number(res.vectorCountAfter) || 0;
  const before = Number(res.vectorCountBefore) || 0;
  const nodeCount = res.nodeCount ?? null;
  const coverage = nodeCount ? `${after}/${nodeCount}（覆盖 ${Math.round((after / nodeCount) * 100)}%）` : `${after}`;
  return [
    `vectors  doc:${res.docId || docId}  向量 ${coverage}`,
    `  新增 ${res.missingInserted ?? 0} · 重嵌 ${res.changedDeleted ?? 0} · 清理孤儿 ${res.staleDeleted ?? 0} · 既有保留 ${res.existingCurrent ?? 0}（before ${before}→after ${after}）`
  ].join('\n');
}

// delete：删除结果一行（未找到与已删除区分）。
export function formatDeleteResult(res: WriteResult | null | undefined, { docId }: { docId?: string | number } = {}) {
  if (!res || res.ok !== true) return `删除失败：${JSON.stringify(res)}`;
  return `${res.changed ? '已删除' : '未找到'} doc ${res.docId || docId}${res.title ? `「${res.title}」` : ''}`;
}

// gc：对象库 mark-sweep 账目一行。
export function formatGcResult(res: WriteResult | null | undefined) {
  if (!res || res.ok !== true) return `gc 失败：${JSON.stringify(res)}`;
  return `对象库 GC 完成：扫描 ${res.scanned} · 可达 ${res.reachable} · 回收 ${res.deleted}`;
}

// MCP/CLI 写动词 --json 收口：store 的写返回是给 IPC/前端的——node 双挂 snake+camel、editBranch 带
// base_snapshot/diff 全文转义串，对 LLM 是纯噪声且每次重复。这里只留结果要点：动作状态、节点
// 关键字段、分支的改增删移计数（由 branch.diff 现算），丢掉重复键与快照大字符串。
export function slimWriteResult(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res;
  const src = res as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [
    'ok', 'action', 'changed',
    'docId', 'baseDocId', 'branchId', 'undoDepth', 'redoDepth',
    'insertedNodeId', 'insertedRefId',
    'nodeId', 'sourceNodeId', 'targetNodeId', 'newParentId',
    'refId', 'entityId', 'entityIds', 'kind', 'status', 'direction',
    'restoredPragmas', 'checkpoint', 'touchedDocIds'
  ]) {
    if (k in src) out[k] = src[k];
  }
  if (src.node && typeof src.node === 'object') {
    const n = src.node as Record<string, unknown>;
    const node: Record<string, unknown> = { id: n.id, address: n.address, node_type: n.node_type, text: n.text, node_note: n.node_note, trust_level: n.trust_level };
    if (n.pending_insert) node.pending_insert = true;
    out.node = node;
  }
  for (const k of ['entity', 'ref', 'link']) {
    if (src[k] && typeof src[k] === 'object') out[k] = src[k];
  }
  const branch = (src.editBranch || src.branch) as Record<string, unknown> | undefined;
  if (branch && typeof branch === 'object' && branch.id != null) {
    const c = parseBranchEntryCounts(branch);
    out.branch = { id: branch.id, status: branch.status, counts: { 改: c.update, 增: c.insert, 删: c.delete, 移: c.move, 其他: c.other, 撤销: c.undone } };
  }
  if (src.history && typeof src.history === 'object') {
    const h = src.history as Record<string, unknown>;
    out.history = { commit_id: h.commit_id || h.id, doc_id: h.doc_id, summary: h.summary, saved_at: h.saved_at };
  }
  return out;
}

// sql：行数 + 每行 key=val（列不固定，按行渲染；长单元格截断）。
export function formatSqlResult(res: WriteResult) {
  const result = res as WriteResult;
  const allRows = res && Array.isArray(res.rows) ? res.rows : [];
  const { rows, total, truncated } = clipRows(allRows);
  const head = `${result.rowCount ?? total} 行${result.truncated ? '（后端已截）' : ''}${truncated ? `（仅渲染前 ${rows.length}，要全部传 json=true）` : ''}`;
  if (!rows.length) return head;
  const lines = [`${head}：`];
  for (const row of rows) {
    lines.push('  ' + Object.entries(row as Record<string, unknown>).map(([k, v]) => `${k}=${cell(v)}`).join('  '));
  }
  return lines.join('\n');
}
