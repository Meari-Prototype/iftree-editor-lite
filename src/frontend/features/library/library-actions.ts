import type { Dispatch, SetStateAction } from 'react';

import type { DocListItem } from '../../../backend/query-api.js';
import type { DocFolderRow } from '../../../backend/db/schema.js';
import type { LibraryEntry } from '../../../backend/library/library-fs.js';
import {
  defaultDocFolderName,
  isSupportedLibraryImport,
  normalizeFsPath
} from '../../lib/doc-utils.js';
import { getUiMessages } from '../../../lang/ui.js';

// 仓库的最小结构（本文件用到的写动词；与 settings-actions 的 RepositoryLike 同惯例）。
interface DocumentRepositoryLike {
  createDocFolder(payload: { name: string; parentId?: unknown }): Promise<unknown>;
  updateDocFolder(payload: { folderId: unknown; patch: { name: string } }): Promise<unknown>;
  deleteDocFolder(payload: { folderId: unknown }): Promise<unknown>;
  moveDocToFolder(payload: { docId: unknown; folderId: unknown }): Promise<unknown>;
  moveLibraryEntry(payload: { sourceRelativePath: string; targetFolderRelativePath: string }): Promise<unknown>;
  deleteDoc(payload: { docId: unknown }): Promise<unknown>;
}

interface DocRef { id?: unknown; }
// 库文件树条目（前端视图）。
interface LibraryItem {
  relativePath?: string;
  name?: unknown;
  fullPath?: string;
  extension?: unknown;
}

interface LibraryActionsDeps {
  busy?: boolean;
  currentDoc?: { doc?: { id?: unknown } | null } | null;
  docBySourcePath: Map<string, DocRef>;
  libraryCutPath?: string;
  documentRepository: DocumentRepositoryLike;
  refreshDocs: (docId?: unknown) => Promise<unknown>;
  openDoc: (docId: unknown) => unknown;
  confirmLeaveEditMode: () => Promise<boolean>;
  showLibraryFileOnly: (item: unknown, notice?: string) => unknown;
  setBusy: (value: boolean) => void;
  setNotice: (message: string) => void;
  setDocFolders: Dispatch<SetStateAction<DocFolderRow[]>>;
  setDocs: Dispatch<SetStateAction<DocListItem[]>>;
  setLibraryTree: Dispatch<SetStateAction<LibraryEntry | null>>;
  setLibraryCutPath: (path: string) => void;
  setSelectedLibraryEntry: Dispatch<SetStateAction<LibraryEntry | null>>;
}

function errorMessage(error: unknown) {
  return (error as { message?: string })?.message || String(error);
}

export function createLibraryActions({
  busy,
  currentDoc,
  docBySourcePath,
  libraryCutPath,
  documentRepository,
  refreshDocs,
  openDoc,
  confirmLeaveEditMode,
  showLibraryFileOnly,
  setBusy,
  setNotice,
  setDocFolders,
  setDocs,
  setLibraryTree,
  setLibraryCutPath,
  setSelectedLibraryEntry
}: LibraryActionsDeps) {
  async function createDocFolder(parentId = null) {
    if (busy) return null;
    setBusy(true);
    try {
      const folder = await documentRepository.createDocFolder({ name: defaultDocFolderName(), parentId });
      await refreshDocs(currentDoc?.doc?.id);
      return folder;
    } catch (error) {
      setNotice(errorMessage(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function renameDocFolder(folderId: unknown, name: string) {
    setBusy(true);
    try {
      await documentRepository.updateDocFolder({ folderId, patch: { name } });
      await refreshDocs(currentDoc?.doc?.id);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocFolder(folder: { id?: unknown; name?: unknown }) {
    const ok = window.confirm(getUiMessages().notices.confirmDeleteFolder(String(folder.name || '')));
    if (!ok) return;
    setBusy(true);
    try {
      const folders = await documentRepository.deleteDocFolder({ folderId: folder.id });
      setDocFolders(folders as DocFolderRow[]);
      setNotice(getUiMessages().notices.folderDeleted);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function moveDocToFolder(doc: { id?: unknown }, folderId: unknown) {
    setBusy(true);
    try {
      const nextDocs = await documentRepository.moveDocToFolder({ docId: doc.id, folderId: folderId || null });
      setDocs(nextDocs as DocListItem[]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function moveLibraryItem(sourceRelativePath: string, targetFolderRelativePath = '') {
    if (!sourceRelativePath) return;
    setBusy(true);
    try {
      const tree = await documentRepository.moveLibraryEntry({ sourceRelativePath, targetFolderRelativePath });
      setLibraryTree(tree as LibraryEntry);
      setLibraryCutPath('');
      await refreshDocs(currentDoc?.doc?.id || null);
      setNotice(getUiMessages().notices.fileMoved);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function cutLibraryItem(item: LibraryItem) {
    if (!item?.relativePath) return;
    setLibraryCutPath(item.relativePath);
    setNotice(getUiMessages().notices.cutItem(String(item.name || '')));
  }

  function pasteLibraryItem(targetFolderRelativePath = '') {
    if (!libraryCutPath) return;
    moveLibraryItem(libraryCutPath, targetFolderRelativePath);
  }

  async function deleteLibraryImport(item: LibraryItem, importedDoc: DocRef) {
    if (!item || !importedDoc) return;
    const ok = window.confirm(getUiMessages().notices.confirmDeleteImport(String(item.name || '')));
    if (!ok) return;
    setBusy(true);
    try {
      const nextDocs = await documentRepository.deleteDoc({ docId: importedDoc.id });
      setDocs(nextDocs as DocListItem[]);
      if (currentDoc?.doc?.id === importedDoc.id) {
        showLibraryFileOnly(item, getUiMessages().notices.importDeletedSourceKept);
      } else {
        setSelectedLibraryEntry(item as LibraryEntry);
        setNotice(getUiMessages().notices.importDeletedSourceKept);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectLibraryFile(item: LibraryItem) {
    const importedDoc = docBySourcePath.get(normalizeFsPath(item?.fullPath));
    if (importedDoc) {
      openDoc(importedDoc.id);
      return;
    }
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    if (!isSupportedLibraryImport(item as LibraryEntry)) {
      setNotice(getUiMessages().notices.unsupportedImport(String(item.extension || getUiMessages().common.unknown)));
      return;
    }
    showLibraryFileOnly(item);
  }

  return {
    createDocFolder,
    renameDocFolder,
    deleteDocFolder,
    moveDocToFolder,
    moveLibraryItem,
    cutLibraryItem,
    pasteLibraryItem,
    deleteLibraryImport,
    selectLibraryFile
  };
}
