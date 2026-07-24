import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import channels from './ipc-channels.js';

let menuHandler: ((action: unknown) => void) | null = null;

ipcRenderer.on(channels.MENU_ACTION, (_event: IpcRendererEvent, action: unknown) => {
  menuHandler?.(action);
});

function invoke(channel: string) {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Electron 只保留浏览器无法稳定完成的 OS 能力；数据库、Agent、设置和检索全部走 Web API。
contextBridge.exposeInMainWorld('iftree', {
  minimizeWindow: invoke(channels.WINDOW_MINIMIZE),
  toggleMaximizeWindow: invoke(channels.WINDOW_TOGGLE_MAXIMIZE),
  closeWindow: invoke(channels.WINDOW_CLOSE),
  openEntityMaintenanceWindow: invoke(channels.ENTITY_OPEN_MAINTENANCE_WINDOW),
  chooseImportFile: invoke(channels.IMPORT_CHOOSE_FILE),
  chooseLocalModelRoot: invoke(channels.SETTINGS_CHOOSE_LOCAL_MODEL_ROOT),
  openPath: invoke(channels.SHELL_OPEN_PATH),
  getDisplayMetrics: invoke(channels.APP_DISPLAY_METRICS),
  setMenuHandler: (handler: ((action: unknown) => void) | null) => { menuHandler = handler; }
});
