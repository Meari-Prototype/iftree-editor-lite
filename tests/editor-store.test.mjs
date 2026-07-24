import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialEditorState,
  beginTransition,
  endTransition,
  lifecycleOf,
  beginHistoryOp,
  endHistoryOp,
  setStacks,
  pushUndoToken,
  rotateStacks
} from '../dist/src/frontend/stores/editor-store.js';
import { HISTORY_STACK_CAP } from '../dist/src/frontend/session/history-stack.js';

// 编辑生命周期状态机（frontend-refactor.md §4.5，按代码实况修正的模型）。
// 约定：非法转移返回原引用（store 层不广播），调用方以引用相等判断是否获准。

test('lifecycle: idle 下 readonly/editing 由 hasBranch 派生（需求 8-3-2 单一真相）', () => {
  const state = initialEditorState();
  assert.equal(lifecycleOf(state, false), 'readonly');
  assert.equal(lifecycleOf(state, true), 'editing');
});

test('lifecycle: beginTransition 仅 idle 可进，过渡中重复触发被拒（双击 race 守卫）', () => {
  const s0 = initialEditorState();
  const entering = beginTransition(s0, 'entering');
  assert.equal(entering.phase.kind, 'entering');
  assert.equal(lifecycleOf(entering, false), 'entering');

  // 双击第二发：entering 中再 begin（entering 或 leaving）都返回原引用。
  assert.equal(beginTransition(entering, 'entering'), entering);
  assert.equal(beginTransition(entering, 'leaving'), entering);

  const back = endTransition(entering);
  assert.equal(back.phase.kind, 'idle');
  assert.equal(endTransition(back), back); // idle 下 endTransition 无操作
});

test('history: in-flight 重入锁（Ctrl+Z 连发守卫）', () => {
  const s0 = initialEditorState();
  const locked = beginHistoryOp(s0);
  assert.equal(locked.historyOpInFlight, true);
  assert.equal(beginHistoryOp(locked), locked); // 重入被拒：原引用
  const released = endHistoryOp(locked);
  assert.equal(released.historyOpInFlight, false);
  assert.equal(endHistoryOp(released), released);
});

test('history: pushUndoToken 封顶挤出最旧条目并上报 evicted', () => {
  let state = initialEditorState();
  state = setStacks(state, Array.from({ length: HISTORY_STACK_CAP }, (_, i) => `t${i}`), []);
  const { state: next, evicted } = pushUndoToken(state, 'fresh');
  assert.equal(next.undoStack.length, HISTORY_STACK_CAP);
  assert.deepEqual(evicted, ['t0']);
  assert.equal(next.undoStack[next.undoStack.length - 1], 'fresh');
});

test('history: rotateStacks 撤销出栈顶、逆 token 入对面栈；重做对称', () => {
  let state = setStacks(initialEditorState(), ['u1', 'u2'], ['r1']);

  const undone = rotateStacks(state, 'undo', 'inv-u2');
  assert.deepEqual(undone.state.undoStack, ['u1']);
  assert.deepEqual(undone.state.redoStack, ['r1', 'inv-u2']);
  assert.deepEqual(undone.evicted, []);

  const redone = rotateStacks(undone.state, 'redo', 'inv-r');
  assert.deepEqual(redone.state.redoStack, ['r1']);
  assert.deepEqual(redone.state.undoStack, ['u1', 'inv-r']);
});
