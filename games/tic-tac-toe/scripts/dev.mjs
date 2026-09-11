/**
 * Runs the game server and the Vite dev server together, and makes sure that
 * killing one kills the other — a stray server holding port 8787 is a confusing
 * way to start debugging.
 */

import { spawn } from 'node:child_process';

const children = [
  spawn('node', ['--watch', 'src/server/index.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
