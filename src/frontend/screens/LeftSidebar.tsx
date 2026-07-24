// 标准文档栏：统一搜索 + DocBrowser，不再上下分割目录面板。
// docBySourcePath 投影与 createLibraryActions 装配随 DocBrowser 迁入（deps 全部来自
// context / commands / repository 单例，不再回流装配根）。

import { useMemo } from 'react';

import { DocBrowser } from '../components/DocBrowser.jsx';
import { SearchView } from '../components/SearchView.jsx';
import { createLibraryActions } from '../features/library/library-actions.js';
import { documentRepository } from '../data/repositories.js';
import { docSourcePath, normalizeFsPath } from '../lib/doc-utils.js';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { useUiLanguage } from '../../lang/ui.js';

export type LeftPanelView = 'files' | 'search';

export function LeftSidebar({ view = 'files' }: { view?: LeftPanelView }) {
  const { messages } = useUiLanguage();
  const searchText = messages.search;
  const { busy, setBusy, setNotice } = useAppUIContext();
  const { docState, layout, misc, search } = useAppState();
  const { document: documentCommands, editor, treeView: treeViewCommands } = useCommands();
  const {
    docs, docFolders, libraryTree, libraryCutPath, currentDoc,
    setDocs, setDocFolders, setLibraryTree, setLibraryCutPath, setSelectedLibraryEntry
  } = docState;
  const { leftWidth, leftCollapsed, leftSidebarRef, docPanelRef } = layout;

  const docBySourcePath = useMemo(() => {
    const byPath = new Map();
    for (const doc of docs) {
      const sourcePath = docSourcePath(doc);
      if (sourcePath) byPath.set(normalizeFsPath(sourcePath), doc);
    }
    return byPath;
  }, [docs]);

  const {
    createDocFolder,
    renameDocFolder,
    deleteDocFolder,
    moveDocToFolder,
    moveLibraryItem,
    cutLibraryItem,
    pasteLibraryItem,
    deleteLibraryImport,
    selectLibraryFile
  } = createLibraryActions({
    busy,
    currentDoc,
    docBySourcePath,
    libraryCutPath,
    documentRepository,
    refreshDocs: documentCommands.refreshDocs,
    openDoc: documentCommands.openDoc,
    confirmLeaveEditMode: () => editor.confirmLeaveEditMode(),
    showLibraryFileOnly: documentCommands.showLibraryFileOnly,
    setBusy,
    setNotice,
    setDocFolders,
    setDocs,
    setLibraryTree,
    setLibraryCutPath,
    setSelectedLibraryEntry
  });

  return (
    <aside
      ref={leftSidebarRef}
      className={`sidebar sidebar-left ${leftCollapsed ? 'collapsed' : ''}`}
      style={{ width: leftWidth }}
    >
      {view === 'search' && (
        <SearchView
          query={search.query}
          setQuery={search.setQuery}
          results={search.results}
          onSearch={search.runSearch}
          selectNode={treeViewCommands.selectNodeAndOpenTree}
          placeholder={search.mode === 'vector' ? searchText.semanticCurrentDocument : searchText.keywordCurrentDocument}
          disabled={search.mode === 'vector' && search.vectorModuleDisabled}
          disabledMessage={search.mode === 'vector' ? search.vectorDisabledMessage : ''}
          mode={search.mode}
          setMode={(mode) => search.setMode(mode === 'vector' ? 'vector' : 'keyword')}
          modeOptions={[
            { value: 'keyword', label: searchText.keyword },
            { value: 'vector', label: searchText.vector }
          ]}
        />
      )}

      {view === 'files' && <DocBrowser
        busy={busy}
        docs={docs}
        docFolders={docFolders}
        libraryTree={libraryTree}
        docBySourcePath={docBySourcePath}
        currentDocId={misc.currentVisualDocId as Parameters<typeof DocBrowser>[0]['currentDocId']}
        libraryCutPath={libraryCutPath}
        docPanelRef={docPanelRef}
        docPanelHeight="auto"
        onRefreshLibrary={docState.refreshLibrary}
        onOpenDoc={documentCommands.openDoc}
        onCreateDoc={documentCommands.createDoc}
        onCreateFolder={createDocFolder as (parentId?: number | null) => unknown}
        onRenameFolder={renameDocFolder}
        onDeleteFolder={deleteDocFolder}
        onDeleteDoc={documentCommands.deleteDoc}
        onMoveDoc={moveDocToFolder}
        libraryNavigationOpen={currentDoc?.virtualType === 'libraryNavigation'}
        onOpenLibraryNavigation={documentCommands.openLibraryNavigation}
        onSelectLibraryFile={selectLibraryFile}
        onMoveLibraryItem={moveLibraryItem}
        onCutLibraryItem={cutLibraryItem}
        onPasteLibraryItem={pasteLibraryItem}
        onDeleteLibraryImport={deleteLibraryImport}
      />}

    </aside>
  );
}
