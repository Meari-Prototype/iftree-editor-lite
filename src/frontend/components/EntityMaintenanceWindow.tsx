import {
  Check,
  Database,
  HelpCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unlink2
} from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useState } from 'react';

import type { DocListItem } from '../../backend/query-api.js';
import { WindowTitlebar } from './common.jsx';
import { rawIftreeApi } from '../data/iftree-api.js';
import { readDatabase, writeDatabase } from '../data/database-client.js';
import { documentRepository } from '../data/document-repository.js';
import {
  bindEntityNode,
  createEntity,
  deleteEntity,
  entityDragPayload,
  entityFromDragEvent,
  fetchEntityBindings,
  fetchEntityDetail,
  fetchEntityList,
  linkEntities,
  removeEntityNodeBinding,
  unlinkEntities,
  type EntityGetResult,
  type EntityListBindingsResult,
  type FormattedEntity
} from '../features/entity/entity-actions.js';
import { getUiMessages, useUiLanguage } from '../../lang/ui.js';

// 视图内对实体/绑定的扩展字段（mergedHitCount 是 entity.get 计算的同义组合并命中数；docTitle 在投影里）。
type EntityView = FormattedEntity & { mergedHitCount?: number };
type BindingRowView = EntityListBindingsResult['rows'][number];
type EntityLinkKind = 'synonym' | 'related';
type BindingSortValue = 'node:asc' | 'node:desc' | 'bm25:desc' | 'bm25:asc';

function initialDocIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const docId = String(new URLSearchParams(window.location.search).get('docId') || '').trim();
  return docId || null;
}

function docDisplayTitle(doc: Partial<DocListItem> | null | undefined = {}): string {
  return String(doc?.title || '').trim() || getUiMessages().common.unnamedDocument;
}

function entityDocTitle(entity: Partial<EntityView> | null | undefined = {}): string {
  return String(entity?.docTitle || '').trim();
}

function entityLabel(entity: Partial<EntityView> | null | undefined = {}, options: { showDocTitle?: boolean } = {}): string {
  const literal = entity?.literal || getUiMessages().common.unnamedEntity;
  const docTitle = options.showDocTitle ? entityDocTitle(entity) : '';
  return docTitle ? `${literal} · ${docTitle}` : literal;
}

function hitText(value: unknown): string {
  return `x${Number(value) || 0}`;
}

interface BindingSortOption {
  value: BindingSortValue;
  label: string;
  sortBy: 'node' | 'bm25';
  sortDirection: 'asc' | 'desc';
}

function bindingSortOptions(): readonly BindingSortOption[] {
  const text = getUiMessages().entity;
  return [
    { value: 'node:asc', label: text.sortNodeAsc, sortBy: 'node', sortDirection: 'asc' },
    { value: 'node:desc', label: text.sortNodeDesc, sortBy: 'node', sortDirection: 'desc' },
    { value: 'bm25:desc', label: text.sortBm25Desc, sortBy: 'bm25', sortDirection: 'desc' },
    { value: 'bm25:asc', label: text.sortBm25Asc, sortBy: 'bm25', sortDirection: 'asc' }
  ];
}

function bindingSortPayload(value: BindingSortValue = 'node:asc'): BindingSortOption {
  const options = bindingSortOptions();
  return options.find((item) => item.value === value) || options[0];
}

function nodeStatusIcon(status: 'bound' | 'ignored') {
  if (status === 'bound') return <Check size={15} />;
  return <HelpCircle size={15} />;
}

function nodeStatusText(status: 'bound' | 'ignored'): string {
  if (status === 'bound') return getUiMessages().entity.bound;
  return getUiMessages().entity.pending;
}

interface EntityLibraryRowProps {
  entity: EntityView;
  active: boolean;
  showDocTitle: boolean;
  onSelect: (entity: EntityView) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, entity: EntityView) => void;
}

function EntityLibraryRow({ entity, active, showDocTitle, onSelect, onDragStart }: EntityLibraryRowProps) {
  const { messages } = useUiLanguage();
  const docTitle = showDocTitle ? entityDocTitle(entity) : '';
  return (
    <button
      type="button"
      className={`maintenance-entity-row${active ? ' active' : ''}${docTitle ? ' with-doc-label' : ''}`}
      draggable
      onClick={() => onSelect(entity)}
      onDragStart={(event) => onDragStart(event, entity)}
    >
      <span className="maintenance-entity-caret">{active ? '▶' : ''}</span>
      <strong>{entity.literal || messages.common.unnamedEntity}</strong>
      {docTitle ? <small title={docTitle}>{docTitle}</small> : null}
      <span>{hitText(entity.hitCount ?? entity.mergedHitCount)}</span>
    </button>
  );
}

interface RelationRowProps {
  entity: EntityView;
  kind: EntityLinkKind;
  showDocTitle: boolean;
  onUnlink: (entity: EntityView, kind: EntityLinkKind) => void;
}

function RelationRow({ entity, kind, showDocTitle, onUnlink }: RelationRowProps) {
  const { messages } = useUiLanguage();
  return (
    <div className="maintenance-relation-row">
      <span>{entityLabel(entity, { showDocTitle })}</span>
      <strong>{hitText(entity.hitCount ?? entity.mergedHitCount)}</strong>
      <button type="button" title={messages.entity.unlinkRelation} aria-label={messages.entity.unlinkRelation} onClick={() => onUnlink(entity, kind)}>
        <Unlink2 size={14} />
        {messages.entity.unlinkShort}
      </button>
    </div>
  );
}

interface BindingRowProps {
  row: BindingRowView;
  onBind: (row: BindingRowView) => void;
  onClear: (row: BindingRowView) => void;
}

function BindingRow({ row, onBind, onClear }: BindingRowProps) {
  const { messages } = useUiLanguage();
  const node = row?.node;
  const status: 'bound' | 'ignored' = row?.status === 'ignored' ? 'ignored' : 'bound';
  return (
    <div className={`maintenance-binding-row ${status}`}>
      <span className="maintenance-binding-status">
        {nodeStatusIcon(status)}
        {nodeStatusText(status)}
      </span>
      <code>{node?.address || node?.id || messages.entity.notLocated}</code>
      <span>{node?.textPreview || messages.entity.noTextFragment}</span>
      <strong>{hitText(row?.hitCount)}</strong>
      {status === 'ignored' ? (
        <button type="button" onClick={() => onBind(row)}>
          <Plus size={14} />
          {messages.entity.bindShort}
        </button>
      ) : (
        <button type="button" onClick={() => onClear(row)}>
          <Unlink2 size={14} />
          {messages.entity.unlinkShort}
        </button>
      )}
    </div>
  );
}

export function EntityMaintenanceWindow() {
  const { messages } = useUiLanguage();
  const text = messages.entity;
  const initialDocId = initialDocIdFromLocation();
  const [notice, setNotice] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [docFilter, setDocFilter] = useState<string>('');
  const [scopeOpen, setScopeOpen] = useState<boolean>(false);
  const [scopeAllDocs, setScopeAllDocs] = useState<boolean>(false);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>(() => (initialDocId ? [initialDocId] : []));
  const [entityQuery, setEntityQuery] = useState<string>('');
  const [entities, setEntities] = useState<EntityView[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityView | null>(null);
  const [entityDetail, setEntityDetail] = useState<EntityGetResult | null>(null);
  const [bindingQuery, setBindingQuery] = useState<string>('');
  const [bindingSort, setBindingSort] = useState<BindingSortValue>('node:asc');
  const [bindingRows, setBindingRows] = useState<BindingRowView[]>([]);
  const [manualNodeId, setManualNodeId] = useState<string>('');

  const selectedDocKey = selectedDocIds.join(',');
  const showEntityDocTitle = scopeAllDocs || selectedDocIds.length !== 1;

  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLocaleLowerCase();
    if (!q) return docs;
    return docs.filter((doc) => docDisplayTitle(doc).toLocaleLowerCase().includes(q));
  }, [docs, docFilter]);

  const scopeLabel = useMemo(() => {
    if (scopeAllDocs) return text.allDocuments;
    if (selectedDocIds.length === 0) return text.noDocumentsSelected;
    if (selectedDocIds.length > 1) return messages.common.documentCount(selectedDocIds.length);
    const doc = docs.find((item) => String(item.id) === String(selectedDocIds[0]));
    return doc ? text.currentDocumentNamed(docDisplayTitle(doc)) : text.currentDocument;
  }, [docs, messages.common, scopeAllDocs, selectedDocIds, text]);

  function scopePayload(): { allDocs: boolean; docIds: string[] } {
    return {
      allDocs: scopeAllDocs,
      docIds: scopeAllDocs ? [] : selectedDocIds
    };
  }

  async function runBusy<T>(task: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      return await task();
    } catch (error) {
      setNotice(String((error as { message?: string } | null | undefined)?.message || ''));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshEntities(options: { keepSelection?: boolean } = {}): Promise<EntityView[]> {
    const result = await fetchEntityList({
      readDatabase,
      ...scopePayload(),
      query: entityQuery
    });
    const rows = result?.rows || [];
    setEntities(rows);
    if (!options.keepSelection) return rows;
    if (!selectedEntity) return rows;
    const nextSelected = rows.find((row) => String(row.id) === String(selectedEntity.id)) || null;
    setSelectedEntity(nextSelected);
    return rows;
  }

  async function refreshSelectedEntity(entity: EntityView | null = selectedEntity): Promise<EntityGetResult | null> {
    if (!entity?.id || !entity?.docId) {
      setEntityDetail(null);
      setBindingRows([]);
      return null;
    }
    const detail = await fetchEntityDetail({
      readDatabase,
      docId: entity.docId,
      entityId: entity.id
    });
    setEntityDetail(detail || null);
    return detail;
  }

  async function refreshBindings(
    entity: EntityView | null = selectedEntity,
    sortValue: BindingSortValue = bindingSort,
    queryValue: string = bindingQuery
  ): Promise<EntityListBindingsResult | null> {
    if (!entity?.id || !entity?.docId) {
      setBindingRows([]);
      return null;
    }
    const sort = bindingSortPayload(sortValue);
    const result = await fetchEntityBindings({
      readDatabase,
      docId: entity.docId,
      entityId: entity.id,
      query: queryValue || entity.literal,
      sortBy: sort.sortBy,
      sortDirection: sort.sortDirection
    });
    setBindingRows(result?.rows || []);
    return result;
  }

  async function selectEntity(entity: EntityView) {
    setSelectedEntity(entity);
    const query = entity?.literal || '';
    setBindingQuery(query);
    await runBusy(async () => {
      await refreshSelectedEntity(entity);
      await refreshBindings(entity, bindingSort, query);
    });
  }

  async function changeBindingSort(value: BindingSortValue) {
    setBindingSort(value);
    await runBusy(() => refreshBindings(selectedEntity, value));
  }

  function dragEntity(event: DragEvent<HTMLButtonElement>, entity: EntityView) {
    event.dataTransfer.setData('application/x-iftree-entity', entityDragPayload(entity));
    event.dataTransfer.setData('text/plain', entity.literal || '');
    event.dataTransfer.effectAllowed = 'copy';
  }

  async function dropRelation(event: DragEvent<HTMLDivElement>, kind: EntityLinkKind) {
    event.preventDefault();
    const source = entityFromDragEvent(event);
    if (!selectedEntity?.id || !source?.id) return;
    if (String(source.id) === String(selectedEntity.id)) {
      setNotice(text.cannotLinkSelf);
      return;
    }
    await runBusy(async () => {
      await linkEntities({
        writeDatabase,
        docId: selectedEntity.docId,
        sourceEntityId: selectedEntity.id,
        targetEntityId: source.id,
        kind
      });
      await refreshEntities({ keepSelection: true });
      await refreshSelectedEntity(selectedEntity);
    });
  }

  async function unlinkRelation(entity: EntityView, kind: EntityLinkKind) {
    if (!selectedEntity?.id || !entity?.id) return;
    await runBusy(async () => {
      await unlinkEntities({
        writeDatabase,
        docId: selectedEntity.docId,
        sourceEntityId: selectedEntity.id,
        targetEntityId: entity.id,
        kind
      });
      await refreshEntities({ keepSelection: true });
      await refreshSelectedEntity(selectedEntity);
    });
  }

  async function createFromQuery() {
    const literal = entityQuery.trim();
    if (!literal) {
      setNotice(text.enterEntityFirst);
      return;
    }
    if (scopeAllDocs || selectedDocIds.length !== 1) {
      setNotice(text.selectOneDocument);
      return;
    }
    await runBusy(async () => {
      // createEntity 返回 unknown（写入回执 IPC 边界）；用 EntityView 形态读 entity 字段。
      const result = await createEntity({
        writeDatabase,
        docId: selectedDocIds[0],
        literal
      }) as { entity?: EntityView } | null;
      await refreshEntities();
      if (result?.entity) await selectEntity(result.entity);
    });
  }

  async function deleteSelectedEntity() {
    if (!selectedEntity?.id) return;
    const ok = window.confirm(text.confirmDelete(entityLabel(selectedEntity, { showDocTitle: showEntityDocTitle })));
    if (!ok) return;
    await runBusy(async () => {
      await deleteEntity({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id
      });
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
      await refreshEntities();
    });
  }

  async function clearRow(row: BindingRowView) {
    if (!selectedEntity?.id || !row?.node?.id) return;
    await runBusy(async () => {
      await removeEntityNodeBinding({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        row
      });
      await refreshBindings(selectedEntity);
    });
  }

  async function bindRow(row: BindingRowView) {
    if (!selectedEntity?.id || !row?.node?.id) return;
    await runBusy(async () => {
      await bindEntityNode({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        nodeId: row.node.id
      });
      await refreshBindings(selectedEntity);
    });
  }

  async function bindManualNode() {
    const nodeId = String(manualNodeId || '').trim();
    if (!selectedEntity?.id || !nodeId) {
      setNotice(text.pasteNodeUuidFirst);
      return;
    }
    await runBusy(async () => {
      await bindEntityNode({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        nodeId
      });
      setManualNodeId('');
      await refreshBindings(selectedEntity);
    });
  }

  function toggleDoc(docId: unknown) {
    const id = String(docId || '').trim();
    if (!id) return;
    setScopeAllDocs(false);
    setSelectedDocIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  function toggleAllDocs(checked: boolean) {
    setScopeAllDocs(checked);
    setSelectedDocIds(checked ? docs.map((doc) => String(doc.id)) : []);
    if (!checked) {
      setEntities([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
    }
  }

  useEffect(() => {
    let alive = true;
    runBusy(async () => {
      // documentRepository.listDocs 返回 unknown（IPC 边界），实际是 normalizeDocRow 投影 = DocListItem[]。
      const rows = await documentRepository.listDocs() as DocListItem[] | null | undefined;
      if (!alive) return;
      setDocs(rows || []);
      if (!initialDocId && rows?.[0]?.id) setSelectedDocIds([String(rows[0].id)]);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (selectedDocIds.length === 0 && !scopeAllDocs) {
      setEntities([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
      return;
    }
    runBusy(() => refreshEntities());
  }, [scopeAllDocs, selectedDocKey]);

  useEffect(() => {
    // rawIftreeApi 返回 Record<string, unknown-like>，setMenuHandler 是动态绑定的 IPC 桥，TS 看不见它的精确签名。
    // 这里收口成本地 setter，注释里写清楚契约。
    type MenuAction = { type?: string; docId?: unknown } | null | undefined;
    const api = rawIftreeApi();
    const setMenuHandler = api.setMenuHandler as ((callback: ((action: MenuAction) => void) | null) => unknown) | undefined;
    if (typeof setMenuHandler !== 'function') return undefined;
    setMenuHandler((action) => {
      if (action?.type !== 'entity-maintenance:focus') return;
      const docId = String(action.docId || '').trim();
      if (docId) {
        setScopeAllDocs(false);
        setSelectedDocIds([docId]);
      }
    });
    return () => { setMenuHandler(null); };
  }, []);

  const detailEntity = entityDetail?.entity || selectedEntity;
  const synonyms = Array.isArray(entityDetail?.synonyms) ? entityDetail.synonyms : [];
  const related = Array.isArray(entityDetail?.related) ? entityDetail.related : [];

  return (
    <div className="entity-maintenance-app" aria-busy={busy}>
      <WindowTitlebar title={text.title} />
      <main className="entity-maintenance-shell">
        <header className="entity-maintenance-title">
          <div>
            <Database size={18} />
            <h1>{text.title}</h1>
          </div>
          <span>{scopeLabel}</span>
        </header>

        {notice && <button type="button" className="entity-maintenance-notice" onClick={() => setNotice('')}>{notice}</button>}

        <section className="entity-maintenance-grid">
          <aside className="maintenance-column maintenance-library">
            <header className="maintenance-column-header">
              <strong>{text.library}</strong>
              <span>{text.bm25Search}</span>
            </header>
            <div className="maintenance-search-row">
              <input
                value={entityQuery}
                onChange={(event) => setEntityQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runBusy(() => refreshEntities());
                }}
                placeholder={text.searchOrCreate}
              />
              <button type="button" onClick={() => runBusy(() => refreshEntities())}>
                <Search size={14} />
              </button>
              <button type="button" onClick={createFromQuery}>
                <Plus size={14} />
                {text.create}
              </button>
            </div>
            <div className="maintenance-entity-list">
              {entities.length > 0 ? entities.map((entity) => (
                <EntityLibraryRow
                  key={entity.id}
                  entity={entity}
                  active={String(selectedEntity?.id || '') === String(entity.id)}
                  showDocTitle={showEntityDocTitle}
                  onSelect={selectEntity}
                  onDragStart={dragEntity}
                />
              )) : <div className="maintenance-empty">{text.noEntities}</div>}
            </div>
            <div className={`entity-scope-picker${scopeOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="entity-scope-toggle"
                aria-expanded={scopeOpen}
                onClick={() => setScopeOpen((current) => !current)}
              >
                <span>{scopeOpen ? '▾' : '▸'}</span>
                {scopeLabel}
              </button>
              {scopeOpen && (
                <>
                  <div className="entity-scope-controls">
                    <input
                      value={docFilter}
                      onChange={(event) => setDocFilter(event.target.value)}
                      placeholder={text.filterDocuments}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={scopeAllDocs}
                        onChange={(event) => toggleAllDocs(event.target.checked)}
                      />
                      {text.allDocuments}
                    </label>
                  </div>
                  <div className="entity-scope-docs">
                    {filteredDocs.map((doc) => (
                      <label key={doc.id}>
                        <input
                          type="checkbox"
                          checked={scopeAllDocs || selectedDocIds.includes(doc.id)}
                          onChange={() => toggleDoc(doc.id)}
                        />
                        <span title={docDisplayTitle(doc)}>{docDisplayTitle(doc)}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </aside>

          <section className="maintenance-column maintenance-relations">
            <header className="maintenance-selected-header">
              <div>
                <span>{text.selected}</span>
                <strong>{detailEntity ? entityLabel(detailEntity, { showDocTitle: showEntityDocTitle }) : text.noEntitySelected}</strong>
                {detailEntity && <small>{hitText(detailEntity.mergedHitCount ?? detailEntity.hitCount)}</small>}
              </div>
              <button type="button" disabled={!selectedEntity} onClick={deleteSelectedEntity}>
                <Trash2 size={14} />
                {text.deleteShort}
              </button>
            </header>

            <div
              className="maintenance-relation-section"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropRelation(event, 'synonym')}
            >
              <div className="maintenance-section-title">
                <span>{text.synonym}</span>
                <small>{text.synonymHint}</small>
              </div>
              {synonyms.length > 0 ? synonyms.map((entity) => (
                <RelationRow key={`synonym-${entity.id}`} entity={entity} kind="synonym" showDocTitle={showEntityDocTitle} onUnlink={unlinkRelation} />
              )) : <div className="maintenance-drop-empty">{text.dragSynonym}</div>}
            </div>

            <div
              className="maintenance-relation-section"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropRelation(event, 'related')}
            >
              <div className="maintenance-section-title">
                <span>{text.related}</span>
                <small>{text.relatedHint}</small>
              </div>
              {related.length > 0 ? related.map((entity) => (
                <RelationRow key={`related-${entity.id}`} entity={entity} kind="related" showDocTitle={showEntityDocTitle} onUnlink={unlinkRelation} />
              )) : <div className="maintenance-drop-empty">{text.dragRelated}</div>}
            </div>
          </section>

          <section className="maintenance-column maintenance-bindings">
            <header className="maintenance-column-header">
              <strong>{text.nodeKeywords}</strong>
              <span>{text.bindingStatus}</span>
            </header>
            <div className="maintenance-binding-search">
              <input
                value={bindingQuery}
                onChange={(event) => setBindingQuery(event.target.value)}
                placeholder={text.currentEntity}
                disabled={!selectedEntity}
              />
              <select
                value={bindingSort}
                disabled={!selectedEntity}
                aria-label={text.bindingSort}
                onChange={(event) => changeBindingSort(event.target.value as BindingSortValue)}
              >
                {bindingSortOptions().map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button type="button" disabled={!selectedEntity} onClick={() => runBusy(() => refreshBindings())}>
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="maintenance-binding-list">
              {bindingRows.length > 0 ? bindingRows.map((row) => (
                <BindingRow
                  key={`${row.status}-${row.node?.id}`}
                  row={row}
                  onBind={bindRow}
                  onClear={clearRow}
                />
              )) : <div className="maintenance-empty">{text.noBindings}</div>}
            </div>
            <div className="maintenance-manual-bind">
              <span>{text.manualBind}</span>
              <input
                value={manualNodeId}
                onChange={(event) => setManualNodeId(event.target.value)}
                placeholder={text.pasteNodeUuid}
                disabled={!selectedEntity}
              />
              <button type="button" disabled={!selectedEntity} onClick={bindManualNode}>
                <Plus size={14} />
                {text.addShort}
              </button>
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
