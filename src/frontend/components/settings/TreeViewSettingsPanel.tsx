// 设置屏「树视图调整」分类面板：默认列宽、列间距、摘要备注默认显隐、新文档默认展开深度。
// 全部走 ui-prefs 的 localStorage（自读自写 + useState 镜像，不收 props）；写完派发
// TREE_VIEW_PREFS_CHANGED_EVENT，已打开的树视图监听后即时重读。

import { Columns3, ListTree, MoveHorizontal, StickyNote } from 'lucide-react';
import { useState } from 'react';

import {
  TREE_VIEW_PREFS_CHANGED_EVENT,
  readTreeColumnGap,
  readTreeDefaultColumnWidth,
  readTreeDefaultDepth,
  readTreeShowNotesDefault,
  writeTreeColumnGap,
  writeTreeDefaultColumnWidth,
  writeTreeDefaultDepth,
  writeTreeShowNotesDefault
} from '../../lib/ui-prefs.js';
import { useUiLanguage } from '../../../lang/ui.js';

// 数字输入共用解析：合法且落在 [min, max] 才落偏好；清空按 0（各键的「自动/内置默认」语义）。
function parseNumberInput(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return 0;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

export function TreeViewSettingsPanel() {
  const { messages } = useUiLanguage();
  const text = messages.settings.treeView;
  const [columnWidth, setColumnWidth] = useState<number>(() => readTreeDefaultColumnWidth());
  const [columnGap, setColumnGap] = useState<number>(() => readTreeColumnGap());
  const [showNotes, setShowNotes] = useState<boolean>(() => readTreeShowNotesDefault());
  const [defaultDepth, setDefaultDepth] = useState<number>(() => readTreeDefaultDepth());

  // 偏好变更广播：C2DMapView 与摘要备注状态各自监听重读，已打开的视图即时跟随。
  const notifyPrefsChanged = () => {
    window.dispatchEvent(new CustomEvent(TREE_VIEW_PREFS_CHANGED_EVENT));
  };

  return (
    <>
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.description}</p>
      </header>

      <section className="settings-group">
        <header>
          <h2>{text.layout}</h2>
          <span>{text.immediate}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Columns3 size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.defaultColumnWidth}</strong>
              <span>{text.defaultColumnWidthDescription}</span>
            </div>
            <div className="settings-row-control">
              <input
                type="number"
                min={0}
                max={1000}
                value={columnWidth}
                onChange={(event) => {
                  const next = parseNumberInput(event.target.value, 0, 1000);
                  if (next === null) return;
                  writeTreeDefaultColumnWidth(next);
                  setColumnWidth(next);
                  notifyPrefsChanged();
                }}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-icon"><MoveHorizontal size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.columnGap}</strong>
              <span>{text.columnGapDescription}</span>
            </div>
            <div className="settings-row-control">
              <input
                type="number"
                min={16}
                max={120}
                value={columnGap}
                onChange={(event) => {
                  const next = parseNumberInput(event.target.value, 16, 120);
                  if (next === null) return;
                  writeTreeColumnGap(next);
                  setColumnGap(next);
                  notifyPrefsChanged();
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.display}</h2>
          <span>{text.defaults}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><StickyNote size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.showSummaryNotesByDefault}</strong>
              <span>{text.showSummaryNotesByDefaultDescription}</span>
            </div>
            <div className="settings-row-control">
              <label className="settings-inline-toggle">
                <input
                  type="checkbox"
                  checked={showNotes}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    writeTreeShowNotesDefault(checked);
                    setShowNotes(checked);
                    notifyPrefsChanged();
                  }}
                />
                <span>{text.showSummaryNotes}</span>
              </label>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-icon"><ListTree size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.defaultDepth}</strong>
              <span>{text.defaultDepthDescription}</span>
            </div>
            <div className="settings-row-control">
              <input
                type="number"
                min={0}
                max={6}
                value={defaultDepth}
                onChange={(event) => {
                  const next = parseNumberInput(event.target.value, 0, 6);
                  if (next === null) return;
                  writeTreeDefaultDepth(next);
                  setDefaultDepth(next);
                  notifyPrefsChanged();
                }}
              />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
