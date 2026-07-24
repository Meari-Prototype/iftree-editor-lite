import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNodeExecutable } from '../src/backend/llm/backend-discovery.js';
import { isSameOrChildPath } from '../src/backend/path-utils.js';
import channels from './ipc-channels.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WEB_URL = process.env.IFTREE_WEB_URL || 'http://127.0.0.1:4317';
const WEB_SERVER_SCRIPT = join(PROJECT_ROOT, 'dist', 'src', 'backend', 'web', 'web-server.js');
const PRELOAD_PATH = join(import.meta.dirname, 'preload.cjs');

let mainWindow: BrowserWindow | null = null;
let entityWindow: BrowserWindow | null = null;
let webServer: ChildProcess | null = null;
let ownsWebServer = false;

async function webReady() {
  try {
    const response = await fetch(`${WEB_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureWebServer() {
  if (await webReady()) return;
  webServer = spawn(resolveNodeExecutable(), [WEB_SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, IFTREE_ELECTRON_SHELL: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true
  });
  ownsWebServer = true;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    if (await webReady()) return;
    if (webServer.exitCode != null) break;
  }
  throw new Error('WebUI 本地服务启动失败');
}

function windowOptions(title: string) {
  return {
    title,
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
}

async function createMainWindow() {
  mainWindow = new BrowserWindow(windowOptions('IFTreeEditorLite'));
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(WEB_URL);
  mainWindow.show();
}

async function openEntityWindow(payload: Record<string, unknown> = {}) {
  const docId = String(payload.docId ?? payload.doc_id ?? '').trim();
  if (entityWindow && !entityWindow.isDestroyed()) {
    entityWindow.show();
    entityWindow.focus();
    entityWindow.webContents.send(channels.MENU_ACTION, { type: 'entity-maintenance:focus', docId: docId || null });
    return { ok: true, reused: true };
  }
  entityWindow = new BrowserWindow(windowOptions('实体维护'));
  entityWindow.on('closed', () => { entityWindow = null; });
  const url = new URL(WEB_URL);
  url.searchParams.set('screen', 'entity-maintenance');
  if (docId) url.searchParams.set('docId', docId);
  await entityWindow.loadURL(url.toString());
  entityWindow.show();
  return { ok: true, reused: false };
}

function registerOsBridge() {
  ipcMain.handle(channels.APP_DISPLAY_METRICS, (event) => {
    // 渲染层 devicePixelRatio 不一定等于真实出片密度：Electron 的 webContents zoomFactor
    // 只放大布局、不抬 devicePixelRatio（DOM 矢量依然锐利，canvas 位图却被拉伸发虚）。
    // canvas 出图密度需要 dpr × zoomFactor，zoomFactor 只能从主进程这里拿。
    const win = BrowserWindow.fromWebContents(event.sender);
    const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    return {
      zoomFactor: event.sender.getZoomFactor(),
      scaleFactor: display.scaleFactor
    };
  });
  ipcMain.handle(channels.WINDOW_MINIMIZE, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle(channels.WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(channels.WINDOW_CLOSE, (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle(channels.ENTITY_OPEN_MAINTENANCE_WINDOW, (_event, payload) => openEntityWindow((payload || {}) as Record<string, unknown>));
  ipcMain.handle(channels.IMPORT_CHOOSE_FILE, async () => {
    const options = {
      title: '选择要导入的文件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        { name: '知识库文件', extensions: ['chm', 'txt', 'md', 'pdf', 'docx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { filePaths: [] } : { filePaths: result.filePaths };
  });
  ipcMain.handle(channels.SETTINGS_CHOOSE_LOCAL_MODEL_ROOT, async () => {
    const options = {
      title: '选择本地模型目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return { path: result.canceled ? '' : (result.filePaths[0] || '') };
  });
  // 在系统文件管理器中显示路径：仅放行 PROJECT_ROOT / appHome 之内的绝对路径（防渲染层
  // 借道打开任意系统目录）；目录直接打开，文件定位到其父目录。
  ipcMain.handle(channels.SHELL_OPEN_PATH, async (_event, payload) => {
    const target = typeof payload === 'string' ? payload : '';
    if (!target || !isAbsolute(target)) return { ok: false, error: '路径无效' };
    const resolved = resolve(target);
    const home = process.env.IFTREE_HOME || join(PROJECT_ROOT, 'database');
    if (!isSameOrChildPath(resolved, PROJECT_ROOT) && !isSameOrChildPath(resolved, home)) {
      return { ok: false, error: '仅允许打开应用目录内的路径' };
    }
    if (!existsSync(resolved)) return { ok: false, error: '路径不存在' };
    const openTarget = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
    const error = await shell.openPath(openTarget);
    return error ? { ok: false, error } : { ok: true };
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await ensureWebServer();
  } catch (error) {
    // 本地 WebUI 服务起不来（找不到 node / 端口被占等）时不能静默悬挂——无窗无提示
    // 也不退出会让用户以为「启动后什么都没发生」。明确报错并退出。
    const message = String((error as { message?: unknown })?.message || error);
    console.error('[iftree] WebUI 本地服务启动失败：', error);
    dialog.showErrorBox('IFTreeEditorLite 启动失败', `无法启动本地服务：${message}`);
    app.quit();
    return;
  }
  registerOsBridge();
  await createMainWindow();
  startCaptureServer();
});

// 窗口截图口：GET http://127.0.0.1:4318/capture 直接返回主窗口当前渲染画面的 PNG
// （capturePage 读 Chromium 已合成的页面位图，被别的窗口挡住也不影响）。
// 仅服务本机 host 的 agent-runtime（ui.screenshot）。虽绑 127.0.0.1，但浏览器里任意
// 网页都能 <img>/fetch 读它（DNS rebinding / 跨标签），把当前窗口截图（含敏感文档）
// 外发。故校验 Host 必须是本机回环地址——浏览器对 127.0.0.1 的跨站请求 Host 仍合法，
// 但对 rebinding 域名（Host 是攻击域名）可挡下；真正调用方 host 进程走 127.0.0.1。
function captureHostAllowed(rawHost: unknown): boolean {
  const value = String(rawHost || '').trim().toLowerCase();
  if (!value || /[\s/?#@\\]/.test(value)) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function startCaptureServer() {
  const server = createServer((request, response) => {
    if (!captureHostAllowed(request.headers.host)) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Host 不允许' }));
      return;
    }
    if (request.method !== 'GET' || request.url !== '/capture') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: '主窗口不存在' }));
      return;
    }
    mainWindow.webContents.capturePage().then((image) => {
      const png = image.toPNG();
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      response.end(png);
    }, (error: unknown) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String((error as { message?: unknown })?.message || error) }));
    });
  });
  server.on('error', (error) => console.error('[capture] 截图口启动失败：', error));
  server.listen(Number(process.env.IFTREE_CAPTURE_PORT) || 4318, '127.0.0.1');
}

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (ownsWebServer && webServer && webServer.exitCode == null) webServer.kill();
});
