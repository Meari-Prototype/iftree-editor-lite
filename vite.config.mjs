import react from '@vitejs/plugin-react';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const backendPort = Number(process.env.IFTREE_WEB_PORT) || 4317;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const webServerScript = join(projectRoot, 'dist', 'src', 'backend', 'web', 'web-server.js');
let backendProcess = null;
let backendOwner = 0;
let backendSpawnInFlight = null;

function ensureWebRuntime() {
  if (!existsSync(webServerScript)) {
    execFileSync(process.execPath, [join(projectRoot, 'scripts', 'build.mjs')], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
  }
}

async function backendHealthy() {
  try {
    const response = await fetch(`${backendOrigin}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await backendHealthy()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

function stopBackend() {
  if (backendProcess && backendProcess.exitCode == null) {
    try { backendProcess.kill(); } catch { /* 忽略重复关闭竞态 */ }
  }
  backendProcess = null;
}

// 后端 4317 可能中途死掉（看门狗误杀、OOM、原生崩溃等）。一旦死了，页面的所有 RPC
// 都会报「Failed to fetch」且表现为"切不了文档"——这里由 vite 侧周期探活、死了就地重拉，
// 让已打开的页面无需刷新即可恢复。并发调用共享同一个 in-flight Promise，避免重复拉起。
function ensureBackendRunning() {
  if (backendProcess && backendProcess.exitCode == null) return Promise.resolve(true);
  if (backendSpawnInFlight) return backendSpawnInFlight;
  backendSpawnInFlight = (async () => {
    try {
      if (await backendHealthy()) return true;
      ensureWebRuntime();
      stopBackend();
      backendProcess = spawn(process.execPath, [webServerScript], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, IFTREE_WEB_PARENT_PID: String(process.pid) },
        windowsHide: true
      });
      return await waitForBackend();
    } finally {
      backendSpawnInFlight = null;
    }
  })();
  return backendSpawnInFlight;
}

// Kimi Work 预览会直接跑 `vite`（不一定经过 npm run dev），所以由 Vite dev server 自己保证本地后端在跑。
const devBackendPlugin = {
  name: 'iftree-dev-backend',
  async configureServer(server) {
    const owner = ++backendOwner;
    await ensureBackendRunning();
    // 周期探活：后端中途死掉时自动重拉（页面无需刷新）。
    const healthTimer = setInterval(() => {
      if (backendOwner !== owner) { clearInterval(healthTimer); return; }
      void ensureBackendRunning();
    }, 5000);
    healthTimer.unref?.();
    server.httpServer?.once('close', () => {
      clearInterval(healthTimer);
      if (backendOwner === owner) stopBackend();
    });
  }
};

function manualChunks(id) {
  const normalized = id.replace(/\\/g, '/');
  if (!normalized.includes('/node_modules/')) return undefined;
  if (normalized.includes('/react/') || normalized.includes('/react-dom/') || normalized.includes('/scheduler/')) {
    return 'vendor-react';
  }
  if (normalized.includes('/lucide-react/') || normalized.includes('/lucide/')) {
    return 'vendor-icons';
  }
  if (normalized.includes('/@radix-ui/')) {
    return 'vendor-radix';
  }
  if (normalized.includes('/pdfjs-dist/')) {
    return 'vendor-pdf';
  }
  if (normalized.includes('/@huggingface/transformers/') || normalized.includes('/onnxruntime-web/')) {
    return 'vendor-ml';
  }
  return 'vendor';
}

export default defineConfig({
  plugins: [react(), devBackendPlugin],
  base: './',
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: backendOrigin,
        changeOrigin: false
      }
    }
  }
});
