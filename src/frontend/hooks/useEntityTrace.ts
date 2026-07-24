import { openEntityMaintenanceAction } from '../features/entity/entity-actions.js';
import { openEntityMaintenanceWindow } from '../data/window-service.js';
import { useAppUIContext } from './useAppUI.js';

export function useEntityTrace({ docId = null }: { docId?: unknown } = {}) {
  const { setNotice } = useAppUIContext();

  async function openEntityMaintenance(): Promise<void> {
    try {
      await openEntityMaintenanceAction({
        docId: docId || null,
        openWindow: openEntityMaintenanceWindow,
        setNotice
      });
    } catch (error) {
      setNotice((error as { message?: string }).message || '');
    }
  }

  return { openEntityMaintenance };
}
