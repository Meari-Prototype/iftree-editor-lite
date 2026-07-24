
import { useEffect, useState } from 'react';


import {
  DEFAULT_SUMMARY_STRATEGIES, normalizeSummaryStrategy,
  summarySkipBelowCount, summaryStrategyDisplayName, summaryStrategyLabel,
  type SummaryItem, type SummaryStrategy as NormalizedSummaryStrategy
} from '../lib/summary-utils.js';
import { useUiLanguage } from '../../lang/ui.js';


interface SummaryStrategyDraft {
  id: string;
  name: string;
  skipBelowChars: number | string;
  minWords: number | string;
  maxWords: number | string;
  ratioPercent: number | string;
}

export interface SummaryConfirmRequest {
  strategyIndex?: number;
  mode?: string;
  strategyOptions?: unknown[];
  strategy?: unknown;
  summaryItems?: unknown[];
  skippedGenerated?: unknown;
  scopeLabel?: string;
  targetLabel?: string;
  selectedLabel?: string;
}

interface SummaryConfirmDialogProps {
  request?: SummaryConfirmRequest | null;
  onCancel: () => void;
  onConfirm?: (strategy: NormalizedSummaryStrategy) => void;
}

export function SummaryConfirmDialog({ request, onCancel, onConfirm }: SummaryConfirmDialogProps) {
  const { messages } = useUiLanguage();
  const requestedStrategyIndex = request?.strategyIndex;
  const strategyIndex = Number.isInteger(requestedStrategyIndex)
    ? requestedStrategyIndex as number
    : (request?.mode === 'article' ? 0 : 1);
  const options = Array.isArray(request?.strategyOptions) && request.strategyOptions.length > 0
    ? request.strategyOptions.map((strategy, index) => normalizeSummaryStrategy(strategy, index))
    : DEFAULT_SUMMARY_STRATEGIES.map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const initial = normalizeSummaryStrategy(
    request?.strategy || options[strategyIndex] || options[0],
    strategyIndex
  );
  const [draft, setDraft] = useState<SummaryStrategyDraft>(initial);

  useEffect(() => {
    setDraft(initial);
  }, [request]);

  const updateNumber = (key: keyof SummaryStrategyDraft, value: string) => {
    setDraft((current) => (
      value === ''
        ? { ...current, [key]: '' }
        : normalizeSummaryStrategy({ ...current, [key]: value }, strategyIndex)
    ));
  };
  const commitNumbers = () => {
    setDraft((current) => normalizeSummaryStrategy(current, strategyIndex));
  };
  const selectStrategy = (id: string) => {
    const selected = options.find((strategy) => strategy.id === id);
    if (selected) setDraft(selected);
  };
  const skippedShort = summarySkipBelowCount((request?.summaryItems || []) as SummaryItem[], draft, strategyIndex);
  const skippedGenerated = Number(request?.skippedGenerated || 0);

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <form
        className="dialog-box summary-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm?.(normalizeSummaryStrategy(draft, strategyIndex));
        }}
      >
        <div className="dialog-header">{messages.summary.confirmTitle}</div>
        <p className="dialog-message">
          {messages.summary.generateMessage(
            request?.scopeLabel || messages.summary.summary,
            request?.targetLabel || messages.common.none
          )}
        </p>
        <div className="summary-confirm-meta">
          <span>{messages.summary.currentSelection(request?.selectedLabel || messages.common.none)}</span>
          <span>{messages.summary.skipOverview(skippedShort, skippedGenerated)}</span>
        </div>
        <label className="dialog-field">
          <span>{messages.summary.reuseConfiguration}</span>
          <select className="dialog-input" value={draft.id} onChange={(event) => selectStrategy(event.target.value)}>
            {options.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {summaryStrategyDisplayName(strategy)} ({summaryStrategyLabel(strategy as Parameters<typeof summaryStrategyLabel>[0])})
              </option>
            ))}
          </select>
        </label>
        <div className="summary-confirm-grid">
          <label className="dialog-field">
            <span>{messages.summary.skipBelow}</span>
            <input className="dialog-input" type="number" min="0" value={draft.skipBelowChars} onBlur={commitNumbers} onChange={(event) => updateNumber('skipBelowChars', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>{messages.summary.minimum}</span>
            <input className="dialog-input" type="number" min="0" value={draft.minWords} onBlur={commitNumbers} onChange={(event) => updateNumber('minWords', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>{messages.summary.maximum}</span>
            <input className="dialog-input" type="number" min="0" value={draft.maxWords} onBlur={commitNumbers} onChange={(event) => updateNumber('maxWords', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>{messages.summary.relativeRatio}</span>
            <input className="dialog-input" type="number" min="0" max="90" step="0.1" value={draft.ratioPercent} onBlur={commitNumbers} onChange={(event) => updateNumber('ratioPercent', event.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{messages.common.cancel}</button>
          <button type="submit">{messages.summary.applyConfiguration}</button>
        </div>
      </form>
    </div>
  );
}
