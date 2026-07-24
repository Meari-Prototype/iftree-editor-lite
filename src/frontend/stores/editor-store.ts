// editorStore：编辑生命周期状态机 + undo/redo 两栈（frontend-refactor.md §4.3/§4.5/§4.6）。
// 纯 TS 转移函数（state → state），可 node --test；非法转移返回原引用（store 不广播）。
//
// 与 §4.5 状态图的对应（实现时按代码实况修正的模型，修正点见 §7 核对记录）：
// - readonly/editing 两个稳定态**派生**自「当前文档是否持有编辑分支」（需求 8-3-2：编辑模式
//   = 持有编辑分支标识，不另设独立开关）——状态机不复制这份真相，branch 数据仍归 docMeta。
// - entering/leaving 两个非稳定态**显式**存这里，取代原 editModeTransitionRef 整把锁：
//   「处于过渡态即拒绝新的 enter/leave」这一条守卫从结构上消灭双击重复 beginEditBranch、
//   连点连发 commit 两个 race。
// - undo/redo 与生命周期正交（readonly 下也有 editor snapshot 栈），重入锁是独立的
//   historyOpInFlight（取代 historyOpInFlightRef），不进 phase。
//
// 两栈条目（命令栈条目，§4.6）：editor snapshot token（id 形如 'editor-N'，后端持全量快照，
// 弹出/挤出须通知后端释放）或 edit branch diff entry（后端 diff 的投影，无需释放）。
// 条目形态由 history-stack.ts 与命令层管，这里只持栈本身。

import { pushCapped } from '../session/history-stack.js';

export type EditorPhase =
  | { kind: 'idle' }
  | { kind: 'entering' }
  | { kind: 'leaving' };

export interface EditorState {
  phase: EditorPhase;
  undoStack: unknown[];
  redoStack: unknown[];
  historyOpInFlight: boolean;
}

export function initialEditorState(): EditorState {
  return {
    phase: { kind: 'idle' },
    undoStack: [],
    redoStack: [],
    historyOpInFlight: false
  };
}

// ─── 生命周期转移（非法转移返回原引用 = 拒绝，调用方以引用相等判断是否获准） ───

// idle → entering/leaving。过渡态中再次触发一律拒绝（原 editModeTransitionRef 的守卫）。
export function beginTransition(state: EditorState, kind: 'entering' | 'leaving'): EditorState {
  if (state.phase.kind !== 'idle') return state;
  return { ...state, phase: { kind } };
}

// entering/leaving → idle（成功或失败都回 idle；readonly 还是 editing 由 editBranch 派生）。
export function endTransition(state: EditorState): EditorState {
  if (state.phase.kind !== 'entering' && state.phase.kind !== 'leaving') return state;
  return { ...state, phase: { kind: 'idle' } };
}

// ─── 4 态观察投影（hasBranch = Boolean(currentDoc?.editBranch)） ───

export type EditorLifecycle = 'readonly' | 'entering' | 'editing' | 'leaving';

export function lifecycleOf(state: EditorState, hasBranch: boolean): EditorLifecycle {
  switch (state.phase.kind) {
    case 'entering': return 'entering';
    case 'leaving': return 'leaving';
    default: return hasBranch ? 'editing' : 'readonly';
  }
}

// ─── undo/redo 栈与重入锁 ───

export function beginHistoryOp(state: EditorState): EditorState {
  if (state.historyOpInFlight) return state;
  return { ...state, historyOpInFlight: true };
}

export function endHistoryOp(state: EditorState): EditorState {
  if (!state.historyOpInFlight) return state;
  return { ...state, historyOpInFlight: false };
}

// 整栈替换（syncEditBranchHistoryStacks / clear 用）。
export function setStacks(state: EditorState, undoStack: unknown[], redoStack: unknown[]): EditorState {
  return { ...state, undoStack, redoStack };
}

// 封顶入栈。evicted 是被挤出的最旧条目，调用方负责通知后端释放快照（history-stack.ts 契约）。
export function pushUndoToken(state: EditorState, token: unknown): { state: EditorState; evicted: unknown[] } {
  const { stack, evicted } = pushCapped(state.undoStack, token);
  return { state: { ...state, undoStack: stack }, evicted };
}

export function pushRedoToken(state: EditorState, token: unknown): { state: EditorState; evicted: unknown[] } {
  const { stack, evicted } = pushCapped(state.redoStack, token);
  return { state: { ...state, redoStack: stack }, evicted };
}

// 撤销/重做各自的出栈 + 入对面栈（restoreEditorSnapshot 成功后的栈轮转）。
export function rotateStacks(state: EditorState, direction: 'undo' | 'redo', inverseToken: unknown): { state: EditorState; evicted: unknown[] } {
  if (direction === 'undo') {
    const { stack, evicted } = pushCapped(state.redoStack, inverseToken);
    return { state: { ...state, undoStack: state.undoStack.slice(0, -1), redoStack: stack }, evicted };
  }
  const { stack, evicted } = pushCapped(state.undoStack, inverseToken);
  return { state: { ...state, redoStack: state.redoStack.slice(0, -1), undoStack: stack }, evicted };
}
