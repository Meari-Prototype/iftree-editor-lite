import { Plus, Trash2
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { newSummaryStrategy, normalizeSummaryConcurrency, normalizeSummaryStrategy, normalizeSummaryStrategySettings, summaryStrategyDisplayName
} from '../../lib/summary-utils.js';
import { useUiLanguage } from '../../../lang/ui.js';

interface SummaryStrategy extends Record<string, unknown> {
  id: string;
  name?: string;
}

interface SummarySettings extends Record<string, unknown> {
  summaryStrategies: SummaryStrategy[];
  activeArticleSummaryStrategyId: string;
  activeNodeSummaryStrategyId: string;
  summaryConcurrency: number;
}

type NumberDrafts = Record<string, string>;

export function SummaryStrategySettingsPanel({
  settings,
  onChange
}: {
  settings?: Record<string, unknown> | null;
  onChange?: (settings: Record<string, unknown>) => void;
}) {
  const { messages } = useUiLanguage();
  const text = messages.settings.summaryStrategy;
  const config = normalizeSummaryStrategySettings(settings || {}) as SummarySettings;
  const strategies = config.summaryStrategies;
  const [editingId, setEditingId] = useState(config.activeNodeSummaryStrategyId || strategies[0]?.id || '');
  const [numberDrafts, setNumberDrafts] = useState<NumberDrafts>({});
  const editing = strategies.find((strategy) => strategy.id === editingId) || strategies[0] || null;
  useEffect(() => {
    if (!strategies.some((strategy) => strategy.id === editingId)) {
      setEditingId(config.activeNodeSummaryStrategyId || strategies[0]?.id || '');
    }
  }, [config.activeNodeSummaryStrategyId, editingId, strategies]);

  const save = (patch: Record<string, unknown>) => onChange?.({ ...(settings || {}), ...patch });
  const saveStrategies = (nextStrategies: SummaryStrategy[], extra: Record<string, unknown> = {}) => {
    const fallback = nextStrategies[0]?.id || '';
    save({
      summaryStrategies: nextStrategies,
      activeArticleSummaryStrategyId: nextStrategies.some((strategy) => strategy.id === config.activeArticleSummaryStrategyId)
        ? config.activeArticleSummaryStrategyId
        : fallback,
      activeNodeSummaryStrategyId: nextStrategies.some((strategy) => strategy.id === config.activeNodeSummaryStrategyId)
        ? config.activeNodeSummaryStrategyId
        : fallback,
      ...extra
    });
  };
  const addStrategy = () => {
    const strategy = newSummaryStrategy(strategies);
    saveStrategies([...strategies, strategy]);
    setEditingId(strategy.id);
  };
  const deleteStrategy = () => {
    if (!editing || strategies.length <= 1) return;
    const ok = window.confirm(text.confirmDelete(summaryStrategyDisplayName(editing as Parameters<typeof summaryStrategyDisplayName>[0]) || text.unnamed));
    if (!ok) return;
    const next = strategies.filter((strategy) => strategy.id !== editing.id);
    const fallback = next[0]?.id || '';
    saveStrategies(next, {
      activeArticleSummaryStrategyId: config.activeArticleSummaryStrategyId === editing.id ? fallback : config.activeArticleSummaryStrategyId,
      activeNodeSummaryStrategyId: config.activeNodeSummaryStrategyId === editing.id ? fallback : config.activeNodeSummaryStrategyId
    });
    setEditingId(fallback);
  };
  const updateStrategy = (patch: Record<string, unknown>) => {
    if (!editing) return;
    saveStrategies(strategies.map((strategy, index) => (
      strategy.id === editing.id ? normalizeSummaryStrategy({ ...strategy, ...patch }, index) : strategy
    )));
  };
  const numberDraftKey = (field: string) => `${editing?.id || ''}:${field}`;
  const numberValue = (field: string): string | number | undefined => {
    const key = numberDraftKey(field);
    return Object.prototype.hasOwnProperty.call(numberDrafts, key) ? numberDrafts[key] : (editing?.[field] as string | number | undefined);
  };
  const settingsNumberValue = (field: string): string | number | undefined => {
    const key = `settings:${field}`;
    return Object.prototype.hasOwnProperty.call(numberDrafts, key) ? numberDrafts[key] : (config[field] as string | number | undefined);
  };
  const updateNumber = (field: string, value: string) => {
    if (!editing) return;
    const key = numberDraftKey(field);
    setNumberDrafts((drafts) => ({ ...drafts, [key]: value }));
    if (value !== '') updateStrategy({ [field]: value });
  };
  const updateSettingsNumber = (field: string, value: string) => {
    const key = `settings:${field}`;
    setNumberDrafts((drafts) => ({ ...drafts, [key]: value }));
    if (value !== '') save({ [field]: normalizeSummaryConcurrency(value) });
  };
  const commitNumberDraft = (field: string) => {
    const key = numberDraftKey(field);
    setNumberDrafts((drafts) => {
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;
      const next = { ...drafts };
      delete next[key];
      return next;
    });
  };
  const commitSettingsNumberDraft = (field: string) => {
    const key = `settings:${field}`;
    setNumberDrafts((drafts) => {
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;
      const next = { ...drafts };
      delete next[key];
      return next;
    });
  };

  return (
    <section className="settings-group">
      <header>
        <h2>{text.algorithm}</h2>
        <span>{text.autoSave}</span>
      </header>
      <div className="llm-settings-card">
        <div className="summary-strategy-current">
          <label className="llm-field">
            <span>{text.article}</span>
            <select value={config.activeArticleSummaryStrategyId} onChange={(event) => save({ activeArticleSummaryStrategyId: event.target.value })}>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{summaryStrategyDisplayName(strategy as Parameters<typeof summaryStrategyDisplayName>[0])}</option>)}
            </select>
          </label>
          <label className="llm-field">
            <span>{text.node}</span>
            <select value={config.activeNodeSummaryStrategyId} onChange={(event) => save({ activeNodeSummaryStrategyId: event.target.value })}>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{summaryStrategyDisplayName(strategy as Parameters<typeof summaryStrategyDisplayName>[0])}</option>)}
            </select>
          </label>
        </div>
        <div className="llm-toolbar">
          <select value={editing?.id || ''} onChange={(event) => setEditingId(event.target.value)}>
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>{summaryStrategyDisplayName(strategy as Parameters<typeof summaryStrategyDisplayName>[0])}</option>
            ))}
          </select>
          <button type="button" onClick={addStrategy}><Plus size={15} />{text.add}</button>
          <button type="button" disabled={strategies.length <= 1} onClick={deleteStrategy}><Trash2 size={15} />{messages.common.delete}</button>
        </div>
        {editing && (
          <div className="llm-form-grid">
            <label className="llm-field">
              <span>{text.batchConcurrency}</span>
              <input type="number" min="1" value={settingsNumberValue('summaryConcurrency')} onBlur={() => commitSettingsNumberDraft('summaryConcurrency')} onChange={(event) => updateSettingsNumber('summaryConcurrency', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>{text.name}</span>
              <input value={summaryStrategyDisplayName(editing as Parameters<typeof summaryStrategyDisplayName>[0]) || ''} onChange={(event) => updateStrategy({ name: event.target.value })} />
            </label>
            <label className="llm-field">
              <span>{text.skipBelow}</span>
              <input type="number" min="0" value={numberValue('skipBelowChars')} onBlur={() => commitNumberDraft('skipBelowChars')} onChange={(event) => updateNumber('skipBelowChars', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>{text.ratio}</span>
              <input type="number" min="0" max="90" step="0.1" value={numberValue('ratioPercent')} onBlur={() => commitNumberDraft('ratioPercent')} onChange={(event) => updateNumber('ratioPercent', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>{text.minWords}</span>
              <input type="number" min="0" value={numberValue('minWords')} onBlur={() => commitNumberDraft('minWords')} onChange={(event) => updateNumber('minWords', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>{text.maxWords}</span>
              <input type="number" min="0" value={numberValue('maxWords')} onBlur={() => commitNumberDraft('maxWords')} onChange={(event) => updateNumber('maxWords', event.target.value)} />
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
