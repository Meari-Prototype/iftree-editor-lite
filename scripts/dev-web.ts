import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const viteArgs = process.argv.slice(2);
const backend = spawn(process.execPath, [join(root, 'dist', 'src', 'backend', 'web', 'web-server.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
// 直接拉起 Vite，避免 npm run dev 递归；npm 传给 dev 的 --host/--port 等参数原样转给 Vite。
const frontend = spawn(process.execPath, [viteBin, ...viteArgs], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

function stop() {
  backend.kill();
  frontend.kill();
}

backend.once('exit', (code) => {
  frontend.kill();
  process.exitCode = code ?? 0;
});
frontend.once('exit', (code) => {
  backend.kill();
  process.exitCode = code ?? 0;
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
