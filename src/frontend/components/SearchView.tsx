import { useState } from 'react';

import type { VectorContentSearchItem } from '../data/operation-services.js';
import { useUiLanguage } from '../../lang/ui.js';

type SearchResult = VectorContentSearchItem;

interface SearchResultGroup {
  term: string;
  rows?: SearchResult[];
}

interface SearchModeOption {
  value: string;
  label: string;
}

function searchResultScore(score: unknown): number {
  return Math.round((Number(score) || 0) * 1000) / 1000;
}

function SearchResultRows({ results, selectNode }: { results?: SearchResult[]; selectNode: (nodeId: SearchResult['node_id'], result: SearchResult) => void }) {
  const { messages } = useUiLanguage();
  return (results || []).map((result) => (
    <button
      key={result.node_id}
      className="search-result"
      onClick={() => selectNode(result.node_id, result)}
      type="button"
    >
      <code>{result.address || messages.search.notLocated}</code>
      <span>{result.text}</span>
      <strong>{searchResultScore(result.score)}</strong>
    </button>
  ));
}

export function SearchView({
  query,
  setQuery,
  results,
  onSearch,
  selectNode,
  placeholder,
  disabled = false,
  disabledMessage = '',
  mode = null,
  setMode = null,
  modeOptions = [],
  groups = []
}: {
  query: string;
  setQuery: (query: string) => void;
  results?: SearchResult[];
  onSearch: () => void;
  selectNode: (nodeId: SearchResult['node_id'], result: SearchResult) => void;
  placeholder?: string;
  disabled?: boolean;
  disabledMessage?: string;
  mode?: string | null;
  setMode?: ((mode: string) => void) | null;
  modeOptions?: SearchModeOption[];
  groups?: SearchResultGroup[];
}) {
  const { messages } = useUiLanguage();
  const text = messages.search;
  const [hasSearched, setHasSearched] = useState(false);
  const canSwitchMode = typeof setMode === 'function' && modeOptions.length > 0;
  const groupedResults = Array.isArray(groups) ? groups : [];
  const hasGroups = groupedResults.length > 0;
  const hasFlatResults = Array.isArray(results) && results.length > 0;
  const hasResults = hasGroups || hasFlatResults;
  const runSearch = () => {
    setHasSearched(true);
    onSearch();
  };
  return (
    <div className="search-surface">
      <div className={`search-bar${canSwitchMode ? ' has-mode-toggle' : ''}`}>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHasSearched(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !disabled) runSearch();
          }}
          placeholder={placeholder || text.inputPlaceholder}
          disabled={disabled}
        />
        {canSwitchMode && (
          <div className="search-mode-toggle" role="group" aria-label={text.keywordMatchMode}>
            {modeOptions.map((option) => (
              <button
                key={option.value}
                className={mode === option.value ? 'active' : ''}
                onClick={() => setMode(option.value)}
                disabled={disabled}
                type="button"
                aria-pressed={mode === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <button onClick={runSearch} disabled={disabled} type="button">{messages.common.search}</button>
      </div>
      <div className="search-results">
        {hasGroups ? groupedResults.map((group) => (
          <section className="search-result-group" key={group.term}>
            <div className="search-result-group-title">
              <span>{group.term}</span>
              <strong>{(group.rows || []).length}</strong>
            </div>
            <SearchResultRows results={group.rows || []} selectNode={selectNode} />
          </section>
        )) : (
          <SearchResultRows results={results} selectNode={selectNode} />
        )}
        {!hasResults && (
          <div className="empty-state" role="status">
            {disabled
              ? disabledMessage
              : hasSearched
                ? text.noResults
                : text.prompt}
          </div>
        )}
      </div>
    </div>
  );
}
