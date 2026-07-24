// C2D 节点统计弹窗。

import { createPortal } from 'react-dom';
import { statsForNode } from './c2d-measure.js';
import type { C2DBlock, C2DTreeIndex, StatsIndex } from './c2d-types';
import { useUiLanguage } from '../../../lang/ui.js';

export function C2DStatsDialog({ node, index, statsIndex, onClose }: {
  node: C2DBlock;
  index: C2DTreeIndex;
  statsIndex: StatsIndex;
  onClose(): void;
}) {
  const { messages } = useUiLanguage();
  const stats = statsForNode(statsIndex, index, node);
  const statRow = (label: string, ownValue: number, subtreeValue: number) => (
    <>
      <div className="c2d-stat-label">{label}</div>
      <div className="c2d-stat-value">{ownValue}</div>
      <div className="c2d-stat-value">{subtreeValue}</div>
    </>
  );
  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box node-dialog c2d-stats-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header with-close">
          <span>{messages.c2d.nodeStatistics}</span>
          <button type="button" onClick={onClose} aria-label={messages.common.close}>x</button>
        </header>
        <div className="dialog-meta">{node.address}</div>
        <section className="c2d-stats-grid">
          <div />
          <strong>{messages.c2d.currentNode}</strong>
          <strong>{messages.c2d.nodeAndSubtree}</strong>
          {statRow(messages.c2d.wordCount, stats.own.words, stats.subtree.words)}
          {statRow(messages.c2d.charactersNoSpaces, stats.own.charsNoSpace, stats.subtree.charsNoSpace)}
          {statRow(messages.c2d.charactersWithSpaces, stats.own.charsWithSpace, stats.subtree.charsWithSpace)}
        </section>
        <section className="c2d-stats-meta">
          <div><span>{messages.c2d.subtreeNodeCount}</span><strong>{stats.subtreeNodeCount}</strong></div>
          <div><span>{messages.c2d.remainingDepth}</span><strong>{stats.remainingDepth}</strong></div>
          <div><span>{messages.c2d.nextDepthWidth}</span><strong>{stats.nextDepthWidth}</strong></div>
        </section>
      </div>
    </div>,
    document.body
  );
}
